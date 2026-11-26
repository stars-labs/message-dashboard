import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';

// sim_balance_checks gains a status, which only a rebuild can add. Dropping a parent table
// in D1 runs ON DELETE actions on its children even with foreign keys deferred, so 084
// rebuilds every table that references it, directly or through messages, and must hand
// back every row, index and trigger unchanged.

const REBUILT = [
  'sim_balance_checks',
  'messages',
  'message_tags',
  'sim_balance_metrics',
  'sim_balance_skill_decisions',
  'sim_balance_skill_jobs',
  'sim_balance_web_jobs',
  'sim_balance_web_events',
  'carrier_bills',
  'carrier_bill_events',
] as const;

const MIGRATIONS = new URL('./', import.meta.url);

async function sql(name: string): Promise<string> {
  return Bun.file(new URL(name, MIGRATIONS)).text();
}

let database: Database;

beforeEach(async () => {
  database = new Database(':memory:');
  database.run('PRAGMA foreign_keys = ON;');
  database.run(await sql('schema.sql'));
  database.run(await sql('reference-data.sql'));
  database.run(`
    INSERT INTO sims (iccid, sim_index, phone_number) VALUES ('iccid-1', 1, '+6580000001');
    INSERT INTO keyword_tags (id, keyword, tag) VALUES (7, 'OTP', 'otp');
    INSERT INTO filter_rules (id, rule_type, pattern) VALUES (3, 'sender', 'PROMO');
    INSERT INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name, notification_sim_iccid,
      account_ref_digest, account_ref_last4, created_by
    ) VALUES (
      'acct-1', 'SG', 'Singtel', 'SGD', 'Singtel S01', 'iccid-1',
      '${'a'.repeat(64)}', '1234', 'auth0|admin'
    );
  `);
  database.run(`
    INSERT INTO sim_balance_checks (
      id, sim_iccid, profile_id, status, outbound_message_id, response_message_id,
      parser_version, step_index, requested_by_subject, deadline_at
    ) SELECT 'check-1', 'iccid-1', id, 'response_received', 'msg-out', 'msg-in',
      'v1', 1, 'auth0|alice', '2026-11-26 10:00:00'
    FROM sim_balance_profiles ORDER BY id LIMIT 1;
    INSERT INTO messages (
      id, phone_iccid, phone_number, content, type, status, filter_status, filter_rule_id,
      purpose, balance_check_id, processing_session_id, verification_code
    ) VALUES
      ('msg-out', 'iccid-1', '+6580000001', '余额', 'sent', 'sent', 'filtered', NULL,
        'balance_maintenance', 'check-1', 'session-1', NULL),
      ('msg-in', 'iccid-1', '10086', '余额 12.30 元 code 4821', 'received', 'received',
        'filtered', 3, 'user', NULL, NULL, '4821');
    INSERT INTO message_tags (message_id, keyword_tag_id, matched_text, position)
      VALUES ('msg-in', 7, '4821', 12);
    INSERT INTO sim_balance_metrics (id, check_id, metric_type, value, currency)
      VALUES (41, 'check-1', 'cash_balance', 12.3, 'CNY');
    INSERT INTO sim_balance_skill_decisions (
      id, check_id, response_message_id, step_index, skill_id, skill_version, model,
      action, decision_json
    ) VALUES (9, 'check-1', 'msg-in', 0, 'skill', '1', 'model', 'complete', '{}');
    INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index, status)
      VALUES ('skill-job-1', 'check-1', 'msg-in', 0, 'completed');
    INSERT INTO sim_balance_web_jobs (id, check_id, provider, status, otp_message_id)
      VALUES ('web-job-1', 'check-1', 'china_unicom', 'completed', 'msg-in');
    INSERT INTO sim_balance_web_events (id, job_id, event_type) VALUES (5, 'web-job-1', 'claimed');
    INSERT INTO carrier_bills (
      id, billing_account_id, source_message_id, amount_minor, currency, due_date,
      received_at, parser_version
    ) VALUES ('bill-1', 'acct-1', 'msg-in', 4200, 'SGD', '2026-12-01', '2026-11-20', 'v1');
    INSERT INTO carrier_bill_events (id, bill_id, event_type, actor_type, source_message_id)
      VALUES ('event-1', 'bill-1', 'detected', 'system', 'msg-in');
  `);
});

const Row = v.record(v.string(), v.unknown());
const NamedSql = v.array(v.object({ name: v.string(), sql: v.string() }));
const Names = v.array(v.object({ name: v.string() }));
const ForeignKeys = v.array(v.looseObject({ table: v.string() }));

function rows(table: string): Record<string, unknown>[] {
  return v.parse(v.array(Row), database.query(`SELECT * FROM "${table}" ORDER BY rowid`).all());
}

function schemaObjects(type: 'index' | 'trigger'): Record<string, string> {
  const found = v.parse(
    NamedSql,
    database
      .query(`SELECT name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL ORDER BY name`)
      .all(type),
  );
  return Object.fromEntries(
    found.map(({ name, sql: text }) => [name, text.replaceAll(/\s+/g, ' ')]),
  );
}

async function migrate(): Promise<void> {
  database.run(await sql('084_balance_batches.sql'));
}

describe('migration 084: balance batches', () => {
  test('keeps every row of every rebuilt table', async () => {
    const before = new Map(REBUILT.map((table) => [table, rows(table)]));

    await migrate();

    for (const table of REBUILT) {
      const expected = before.get(table) ?? [];
      expect([table, rows(table)]).toEqual([
        table,
        table === 'sim_balance_checks'
          ? expected.map((row) => ({ ...row, batch_id: null }))
          : expected,
      ]);
    }
  });

  test('restores every index and trigger, and adds the batch index', async () => {
    const indexes = schemaObjects('index');
    const triggers = schemaObjects('trigger');

    await migrate();

    const after = schemaObjects('index');
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(indexes), 'idx_balance_checks_batch'].sort(),
    );
    for (const [name, text] of Object.entries(indexes))
      expect([name, after[name]]).toEqual([name, text]);
    expect(schemaObjects('trigger')).toEqual(triggers);
  });

  test('leaves no table behind and every foreign key pointing at a live table', async () => {
    await migrate();

    expect(
      database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_new' ESCAPE '\\'",
        )
        .all(),
    ).toEqual([]);
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    const tables = new Set(
      v
        .parse(Names, database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all())
        .map(({ name }) => name),
    );
    for (const table of [...REBUILT, 'sim_balance_batches']) {
      for (const fk of v.parse(
        ForeignKeys,
        database.query(`PRAGMA foreign_key_list("${table}")`).all(),
      )) {
        expect([table, tables.has(fk.table)]).toEqual([table, true]);
      }
    }
  });

  test('keeps the foreign key actions working on the rebuilt tables', async () => {
    await migrate();

    expect(() => database.run("DELETE FROM carrier_bill_events WHERE id = 'event-1'")).toThrow(
      'carrier bill events are immutable',
    );
    database.run("DELETE FROM messages WHERE id = 'msg-in'");
    expect(rows('message_tags')).toEqual([]);
    expect(
      database
        .query(
          'SELECT source_message_id FROM carrier_bills UNION ALL SELECT otp_message_id FROM sim_balance_web_jobs',
        )
        .all(),
    ).toEqual([{ source_message_id: null }, { source_message_id: null }]);

    database.run("DELETE FROM sim_balance_checks WHERE id = 'check-1'");
    expect(rows('sim_balance_metrics')).toEqual([]);
    expect(rows('sim_balance_web_events')).toEqual([]);
    expect(database.query('SELECT balance_check_id FROM messages').all()).toEqual([
      { balance_check_id: null },
    ]);
  });

  test('accepts a cancelled check in a batch, and still rejects an unknown status', async () => {
    await migrate();

    database.run(
      "INSERT INTO sim_balance_batches (id, requested_by_subject) VALUES ('batch-1', 'auth0|alice')",
    );
    database.run(
      "UPDATE sim_balance_checks SET status = 'cancelled', batch_id = 'batch-1' WHERE id = 'check-1'",
    );
    expect(database.query('SELECT status, batch_id FROM sim_balance_checks').get()).toEqual({
      status: 'cancelled',
      batch_id: 'batch-1',
    });
    expect(() =>
      database.run("UPDATE sim_balance_checks SET status = 'paused' WHERE id = 'check-1'"),
    ).toThrow('CHECK constraint failed');
    expect(() =>
      database.run("UPDATE sim_balance_checks SET batch_id = 'no-batch' WHERE id = 'check-1'"),
    ).toThrow('FOREIGN KEY constraint failed');
  });
});
