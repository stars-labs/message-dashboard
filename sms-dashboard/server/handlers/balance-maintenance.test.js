import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { expireStaleBalanceChecks } from './balance-queries.js';

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const database = this.database;
    return {
      bind(...params) {
        return {
          sql,
          params,
          all: async () => ({ results: database.query(sql).all(...params) }),
          run: async () => {
            database.query(sql).run(...params);
            return {
              meta: { changes: database.query('SELECT changes() AS value').get().value },
            };
          },
        };
      },
    };
  }

  async batch(statements) {
    return this.database.transaction(() => statements.map((statement) => {
      this.database.query(statement.sql).run(...statement.params);
      return {
        meta: { changes: this.database.query('SELECT changes() AS value').get().value },
      };
    }))();
  }
}

describe('balance timeout maintenance D1 flow', () => {
  let sqlite;
  let db;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sims (iccid TEXT PRIMARY KEY, number TEXT);
      CREATE VIEW device_view AS SELECT iccid, number FROM sims;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, phone_iccid TEXT, phone_number TEXT, content TEXT,
        timestamp TIMESTAMP, type TEXT, recipient TEXT, status TEXT,
        filter_status TEXT, purpose TEXT DEFAULT 'user', balance_check_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_profiles (
        id TEXT PRIMARY KEY, expected_senders TEXT, parser_version TEXT,
        response_window_minutes INTEGER, conversation_steps TEXT DEFAULT '[]',
        skill_config TEXT DEFAULT '{}', destination TEXT
      );
      CREATE TABLE sim_balance_checks (
        id TEXT PRIMARY KEY, sim_iccid TEXT, profile_id TEXT,
        requested_at TIMESTAMP, sent_at TIMESTAMP, completed_at TIMESTAMP,
        status TEXT, outbound_message_id TEXT, response_message_id TEXT,
        response_sender TEXT, raw_response TEXT, error TEXT, parser_version TEXT,
        step_index INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT, metric_type TEXT,
        value REAL, unit TEXT, currency TEXT, expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(check_id, metric_type)
      );
      CREATE TABLE sim_balance_skill_jobs (
        id TEXT PRIMARY KEY, check_id TEXT, response_message_id TEXT,
        step_index INTEGER, status TEXT DEFAULT 'pending', lease_owner TEXT,
        lease_expires_at TIMESTAMP, last_error TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO sims VALUES ('iccid-s66', '+85246820057');
      INSERT INTO sim_balance_profiles VALUES (
        'hk-cmhk-sms-menu-v1', '["12580"]', 'hk-cmhk-balance-v1', 30,
        '[]', '{"id":"readonly-balance-menu","max_turns":4}', '12580'
      );
      INSERT INTO sim_balance_checks (
        id, sim_iccid, profile_id, requested_at, sent_at, completed_at, status,
        outbound_message_id, error, parser_version
      ) VALUES
        ('check-failed', 'iccid-s66', 'hk-cmhk-sms-menu-v1',
         '2026-08-24 07:48:54', NULL, '2026-08-24 07:49:05', 'failed',
         'sent-failed', 'SMS submission was not confirmed', 'hk-cmhk-balance-v1'),
        ('check-stale', 'iccid-s66', 'hk-cmhk-sms-menu-v1',
         datetime('now', '-40 minutes'), datetime('now', '-40 minutes'), NULL,
         'awaiting_response', 'sent-stale', NULL, 'hk-cmhk-balance-v1'),
        ('check-fresh', 'iccid-s66', 'hk-cmhk-sms-menu-v1',
         datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), NULL,
         'awaiting_response', 'sent-fresh', NULL, 'hk-cmhk-balance-v1');
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, timestamp, type, recipient,
        status, filter_status, purpose, balance_check_id
      ) VALUES
        ('sent-failed', 'iccid-s66', '+85246820057', '0',
         '2026-08-24 07:48:54', 'sent', '12580', 'unknown', 'filtered',
         'balance_maintenance', 'check-failed'),
        ('reply-one', 'iccid-s66', '85212580', '歡迎使用短信營業廳',
         '2026-08-24T07:49:22.000Z', 'received', NULL, 'received', 'clean',
         'user', NULL),
        ('reply-two', 'iccid-s66', '85212580', '歡迎使用短信營業廳',
         '2026-08-24T07:51:32.000Z', 'received', NULL, 'received', 'clean',
         'user', NULL),
        ('sent-stale', 'iccid-s66', '+85246820057', '0',
         datetime('now', '-40 minutes'), 'sent', '12580', 'sent', 'filtered',
         'balance_maintenance', 'check-stale'),
        ('sent-fresh', 'iccid-s66', '+85246820057', '0',
         datetime('now', '-5 minutes'), 'sent', '12580', 'sent', 'filtered',
         'balance_maintenance', 'check-fresh');
    `);
    db = new D1Adapter(sqlite);
  });

  afterEach(() => sqlite.close());

  test('expires stale unanswered checks without scanning historical replies', async () => {
    const result = await expireStaleBalanceChecks(db);

    expect(result.expired).toBe(1);
    expect(sqlite.query(`
      SELECT status, response_message_id, error
      FROM sim_balance_checks WHERE id = 'check-failed'
    `).get()).toEqual({
      status: 'failed',
      response_message_id: null,
      error: 'SMS submission was not confirmed',
    });
    expect(sqlite.query(`
      SELECT id, purpose, balance_check_id
      FROM messages WHERE id IN ('reply-one', 'reply-two') ORDER BY id
    `).all()).toEqual([
      { id: 'reply-one', purpose: 'user', balance_check_id: null },
      { id: 'reply-two', purpose: 'user', balance_check_id: null },
    ]);
    expect(sqlite.query(`
      SELECT id, status FROM sim_balance_checks
      WHERE id IN ('check-stale', 'check-fresh') ORDER BY id
    `).all()).toEqual([
      { id: 'check-fresh', status: 'awaiting_response' },
      { id: 'check-stale', status: 'timed_out' },
    ]);
    expect(sqlite.query(`SELECT COUNT(*) AS value FROM sim_balance_skill_jobs`).get().value).toBe(0);
  });
});
