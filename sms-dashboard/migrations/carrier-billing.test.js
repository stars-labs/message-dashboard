import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

let database;

beforeEach(async () => {
  database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (
      iccid TEXT PRIMARY KEY,
      service_type TEXT NOT NULL,
      country_code TEXT,
      carrier TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    INSERT INTO sims VALUES
      ('notification-sim', 'postpaid', 'SG', 'Singtel'),
      ('linked-sim', 'postpaid', 'SG', 'Singtel'),
      ('other-sim', 'postpaid', 'SG', 'Singtel');
    INSERT INTO messages VALUES ('message-1', 'retained source');
  `);
  const migration = await Bun.file(
    new URL('./066_add_carrier_billing.sql', import.meta.url),
  ).text();
  database.exec(migration);
  database.query(`
    INSERT INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES (?, 'SG', 'Singtel', 'SGD', 'Singtel corporate account',
      'notification-sim', ?, '5678', 'active', 'auth0|admin')
  `).run('account-1', 'a'.repeat(64));
  const streamMigration = await Bun.file(
    new URL('./069_unique_active_billing_stream_per_sim.sql', import.meta.url),
  ).text();
  database.exec(streamMigration);
});

describe('carrier billing migration', () => {
  test('allows only one active bill stream per receiving SIM', () => {
    const insert = database.query(`
      INSERT INTO carrier_billing_accounts (
        id, country_code, carrier, currency, display_name,
        notification_sim_iccid, account_ref_digest, account_ref_last4,
        status, created_by
      ) VALUES (?, 'SG', 'Singtel', 'SGD', ?, 'notification-sim', ?, ?, ?, 'system:sms')
    `);

    expect(() => insert.run(
      'account-2',
      'Duplicate active stream',
      'b'.repeat(64),
      '4321',
      'active',
    )).toThrow();
    insert.run('account-3', 'Inactive history', 'c'.repeat(64), '8765', 'inactive');
  });

  test('stores money as integer cents and validates real ISO due dates', () => {
    const insert = database.query(`
      INSERT INTO carrier_bills (
        id, billing_account_id, source_message_id, amount_minor, currency,
        due_date, received_at, parser_version
      ) VALUES (?, 'account-1', 'message-1', ?, 'SGD', ?,
        '2026-08-01T00:00:00Z', 'sg-singtel-postpaid-bill-sms-v1')
    `);

    insert.run('bill-1', 4280, '2026-09-14');
    expect(database.query(`
      SELECT amount_minor, typeof(amount_minor) AS amount_type, due_date
      FROM carrier_bills WHERE id = 'bill-1'
    `).get()).toEqual({
      amount_minor: 4280,
      amount_type: 'integer',
      due_date: '2026-09-14',
    });
    expect(() => insert.run('bill-float', 42.8, '2026-10-14')).toThrow();
    expect(() => insert.run('bill-date', 4280, '2026-02-31')).toThrow();
    expect(() => insert.run('bill-format', 4280, '14 Sep 2026')).toThrow();
  });

  test('requires explicit verified membership and one active account per SIM', () => {
    const insert = database.query(`
      INSERT INTO carrier_billing_account_sims (
        billing_account_id, sim_iccid, verification_source,
        verified_at, verified_by
      ) VALUES (?, ?, 'contract_or_bill', '2026-08-24T00:00:00Z', 'auth0|admin')
    `);
    insert.run('account-1', 'linked-sim');
    expect(database.query(`
      SELECT sim_iccid, verification_source, removed_at
      FROM carrier_billing_account_sims
    `).get()).toEqual({
      sim_iccid: 'linked-sim',
      verification_source: 'contract_or_bill',
      removed_at: null,
    });
    expect(() => insert.run('account-1', 'unknown-sim')).toThrow();

    database.query(`
      INSERT INTO carrier_billing_accounts (
        id, country_code, carrier, currency, display_name,
        notification_sim_iccid, account_ref_digest, account_ref_last4,
        status, created_by
      ) VALUES ('account-2', 'SG', 'Singtel', 'SGD', 'Second account',
        'other-sim', ?, '4321', 'active', 'auth0|admin')
    `).run('b'.repeat(64));
    expect(() => insert.run('account-2', 'linked-sim')).toThrow();

    database.query(`
      UPDATE carrier_billing_account_sims
      SET removed_at = '2026-08-25T00:00:00Z'
      WHERE billing_account_id = 'account-1' AND sim_iccid = 'linked-sim'
    `).run();
    insert.run('account-2', 'linked-sim');
  });

  test('keeps evidence immutable and rejects duplicate bills', () => {
    database.query(`
      INSERT INTO carrier_bills (
        id, billing_account_id, source_message_id, amount_minor, currency,
        due_date, received_at, parser_version
      ) VALUES ('bill-1', 'account-1', 'message-1', 4280, 'SGD',
        '2026-09-14', '2026-08-24T00:00:00Z',
        'sg-singtel-postpaid-bill-sms-v1')
    `).run();

    expect(() => database.query(`
      UPDATE carrier_bills SET amount_minor = 9999 WHERE id = 'bill-1'
    `).run()).toThrow('immutable');
    expect(() => database.query(`
      INSERT INTO carrier_bills (
        id, billing_account_id, amount_minor, currency, due_date,
        received_at, parser_version
      ) VALUES ('duplicate-cycle', 'account-1', 4280, 'SGD', '2026-09-14',
        '2026-08-24T00:00:01Z', 'sg-singtel-postpaid-bill-sms-v1')
    `).run()).toThrow();
    expect(() => database.query(`
      INSERT INTO carrier_bills (
        id, billing_account_id, source_message_id, amount_minor, currency,
        due_date, received_at, parser_version
      ) VALUES ('duplicate-source', 'account-1', 'message-1', 4280, 'SGD',
        '2026-10-14', '2026-08-24T00:00:01Z',
        'sg-singtel-postpaid-bill-sms-v1')
    `).run()).toThrow();
  });

  test('preserves normalized history when retained source messages are deleted', () => {
    database.exec(`
      INSERT INTO carrier_bills (
        id, billing_account_id, source_message_id, amount_minor, currency,
        due_date, received_at, parser_version
      ) VALUES ('bill-1', 'account-1', 'message-1', 4280, 'SGD',
        '2026-09-14', '2026-08-24T00:00:00Z',
        'sg-singtel-postpaid-bill-sms-v1');
      INSERT INTO carrier_bill_events (
        id, bill_id, event_type, actor_type, source_message_id, metadata_json
      ) VALUES (
        'event-1', 'bill-1', 'detected', 'system', 'message-1', '{"source":"sms"}'
      );
      DELETE FROM messages WHERE id = 'message-1';
    `);

    expect(database.query(`
      SELECT source_message_id FROM carrier_bills WHERE id = 'bill-1'
    `).get()).toEqual({ source_message_id: null });
    expect(database.query(`
      SELECT source_message_id FROM carrier_bill_events WHERE id = 'event-1'
    `).get()).toEqual({ source_message_id: null });
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('makes bill events append-only while allowing source retention cleanup', () => {
    database.exec(`
      INSERT INTO carrier_bills (
        id, billing_account_id, amount_minor, currency, due_date,
        received_at, parser_version
      ) VALUES ('bill-1', 'account-1', 4280, 'SGD', '2026-09-14',
        '2026-08-24T00:00:00Z', 'sg-singtel-postpaid-bill-sms-v1');
      INSERT INTO carrier_bill_events (
        id, bill_id, event_type, actor_type, metadata_json
      ) VALUES ('event-1', 'bill-1', 'paid', 'user', '{}');
    `);

    expect(() => database.query(`
      UPDATE carrier_bill_events SET metadata_json = '{"changed":true}'
      WHERE id = 'event-1'
    `).run()).toThrow('immutable');
    expect(() => database.query(`
      DELETE FROM carrier_bill_events WHERE id = 'event-1'
    `).run()).toThrow('immutable');
  });
});
