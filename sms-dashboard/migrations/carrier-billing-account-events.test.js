import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

let database;

beforeEach(async () => {
  database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (iccid TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY);
    INSERT INTO sims VALUES ('notification-sim');
  `);
  for (const name of ['066_add_carrier_billing.sql', '067_add_carrier_billing_account_events.sql']) {
    database.exec(await Bun.file(new URL(`./${name}`, import.meta.url)).text());
  }
  database.exec(`
    INSERT INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES (
      'account-1', 'SG', 'Singtel', 'SGD', 'Singtel account',
      'notification-sim', '${'a'.repeat(64)}', '5678', 'active', 'auth0|admin'
    );
  `);
});

describe('carrier billing account event migration', () => {
  test('adds optimistic account versions and mutation ownership', () => {
    expect(database.query(`
      SELECT version, last_mutation_id FROM carrier_billing_accounts WHERE id = 'account-1'
    `).get()).toEqual({ version: 1, last_mutation_id: null });

    database.query(`
      UPDATE carrier_billing_accounts
      SET version = version + 1, last_mutation_id = 'mutation-1'
      WHERE id = 'account-1' AND version = 1
    `).run();
    expect(database.query(`
      SELECT version, last_mutation_id FROM carrier_billing_accounts WHERE id = 'account-1'
    `).get()).toEqual({ version: 2, last_mutation_id: 'mutation-1' });
  });

  test('keeps account mutations append-only and user-idempotent', () => {
    database.query(`
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject,
        idempotency_key, metadata_json
      ) VALUES (?, 'account-1', 'members_changed', 'auth0|admin', ?, '{}')
    `).run('event-1', 'members-account-1-v1');

    expect(() => database.query(`
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject,
        idempotency_key, metadata_json
      ) VALUES (?, 'account-1', 'members_changed', 'auth0|admin', ?, '{}')
    `).run('event-2', 'members-account-1-v1')).toThrow();
    expect(() => database.query(`
      UPDATE carrier_billing_account_events SET metadata_json = '{"changed":true}'
      WHERE id = 'event-1'
    `).run()).toThrow('immutable');
    expect(() => database.query(`
      DELETE FROM carrier_billing_account_events WHERE id = 'event-1'
    `).run()).toThrow('immutable');
  });
});
