import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { balanceSkillRunnerHandler } from './balance-skill-runner.js';

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const database = this.database;
    return {
      bind(...params) {
        return {
          first: async () => database.query(sql).get(...params) || null,
          all: async () => ({ results: database.query(sql).all(...params) }),
          run: async () => {
            database.query(sql).run(...params);
            return { meta: { changes: database.query('SELECT changes() AS value').get().value } };
          },
          sql,
          params,
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

function workerRequest(db, { id = null, body = null, runnerId = 'runner-1' } = {}) {
  return {
    env: { API_KEY: 'secret', DB: db },
    headers: new Headers({ 'X-API-Key': 'secret' }),
    url: `https://example.com/api/control/balance-skills/jobs/claim?runner_id=${runnerId}`,
    params: id ? { id } : {},
    json: async () => body,
  };
}

describe('balance skill runner D1 flow', () => {
  let sqlite;
  let db;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sims (iccid TEXT PRIMARY KEY, number TEXT);
      CREATE VIEW device_view AS SELECT iccid, number FROM sims;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, phone_iccid TEXT, phone_number TEXT, content TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, type TEXT, recipient TEXT,
        status TEXT, filter_status TEXT, purpose TEXT, balance_check_id TEXT
      );
      CREATE TABLE sim_balance_profiles (
        id TEXT PRIMARY KEY, country_code TEXT, carrier TEXT, method TEXT,
        command TEXT, destination TEXT, expected_senders TEXT, parser_version TEXT,
        response_window_minutes INTEGER, discovery_enabled INTEGER, enabled INTEGER,
        conversation_steps TEXT DEFAULT '[]', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_checks (
        id TEXT PRIMARY KEY, sim_iccid TEXT, profile_id TEXT,
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, sent_at TIMESTAMP,
        deadline_at TIMESTAMP,
        completed_at TIMESTAMP, status TEXT, outbound_message_id TEXT,
        response_message_id TEXT, response_sender TEXT, raw_response TEXT,
        error TEXT, parser_version TEXT, step_index INTEGER DEFAULT 0,
        requested_by_subject TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT, metric_type TEXT,
        value REAL, unit TEXT, currency TEXT, expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(check_id, metric_type)
      );
      INSERT INTO sims VALUES ('iccid-1', '+8613500000000');
      INSERT INTO sim_balance_profiles (
        id, country_code, carrier, method, command, destination, expected_senders,
        parser_version, response_window_minutes, discovery_enabled, enabled
      ) VALUES (
        'cn-mobile-sms-menu-v1', 'CN', 'China Mobile', 'sms', '10086', '10086',
        '["10086"]', 'cn-mobile-balance-v1', 30, 1, 0
      );
    `);
    sqlite.exec(await Bun.file('migrations/042_add_balance_runtime_skills.sql').text());
    db = new D1Adapter(sqlite);
  });

  afterEach(() => sqlite.close());

  function seedJob(content) {
    sqlite.query(`
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, type, status, filter_status, purpose
      ) VALUES ('reply-1', 'iccid-1', '10086', ?, 'received', 'received', 'filtered', 'balance_maintenance')
    `).run(content);
    sqlite.exec(`
      INSERT INTO sim_balance_checks (
        id, sim_iccid, profile_id, status, response_message_id, response_sender,
        raw_response, parser_version, step_index
      ) VALUES (
        'check-1', 'iccid-1', 'cn-mobile-sms-menu-v1', 'response_received',
        'reply-1', '10086', '${content.replaceAll("'", "''")}', 'cn-mobile-balance-v1', 0
      );
      INSERT INTO sim_balance_skill_jobs (
        id, check_id, response_message_id, step_index
      ) VALUES ('job-1', 'check-1', 'reply-1', 0);
    `);
  }

  async function claim() {
    const response = await balanceSkillRunnerHandler.claim(workerRequest(db));
    expect(response.status).toBe(200);
    return response.json();
  }

  test('leases a job and queues only a validated carrier menu option', async () => {
    seedJob('11.账务查询\n12.客户服务');
    const job = await claim();
    expect(job.menu_options[0]).toEqual({ value: '11', label: '账务查询' });

    const response = await balanceSkillRunnerHandler.decide(workerRequest(db, {
      id: job.id,
      body: {
        runner_id: 'runner-1', model: 'company-model',
        decision: { action: 'reply', selected_option: '11', confidence: 0.98 },
      },
    }));
    expect(response.status).toBe(202);
    expect(sqlite.query("SELECT content, recipient FROM messages WHERE type='sent'").get())
      .toEqual({ content: '11', recipient: '10086' });
    expect(sqlite.query("SELECT status, step_index FROM sim_balance_checks WHERE id='check-1'").get())
      .toEqual({ status: 'queued', step_index: 1 });
    expect(sqlite.query("SELECT status FROM sim_balance_skill_jobs WHERE id='job-1'").get().status)
      .toBe('completed');
  });

  test('does not let a legacy runner claim a Dashboard-owned job', async () => {
    seedJob('11.账务查询\n12.客户服务');
    sqlite.exec("UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'");

    const response = await balanceSkillRunnerHandler.claim(workerRequest(db));
    expect(response.status).toBe(204);
    expect(sqlite.query("SELECT status FROM sim_balance_skill_jobs WHERE id='job-1'").get().status)
      .toBe('pending');
  });

  test('stores a balance only when the AI value matches exact SMS evidence', async () => {
    seedJob('当前可用话费余额为82.36元。');
    const job = await claim();
    const response = await balanceSkillRunnerHandler.decide(workerRequest(db, {
      id: job.id,
      body: {
        runner_id: 'runner-1', model: 'company-model',
        decision: {
          action: 'complete', balance: 82.36, currency: 'CNY', confidence: 0.99,
          evidence: '余额为82.36元',
        },
      },
    }));
    expect(response.status).toBe(200);
    expect(sqlite.query("SELECT status FROM sim_balance_checks WHERE id='check-1'").get().status)
      .toBe('parsed');
    expect(sqlite.query("SELECT value, currency FROM sim_balance_metrics WHERE check_id='check-1'").get())
      .toEqual({ value: 82.36, currency: 'CNY' });
  });

  test('terminalizes a safely stopped unresolved reply as unparsed', async () => {
    seedJob('请前往运营商APP查询余额。');
    const job = await claim();
    const response = await balanceSkillRunnerHandler.decide(workerRequest(db, {
      id: job.id,
      body: {
        runner_id: 'runner-1', model: 'company-model',
        decision: { action: 'stop', confidence: 0.99, reason: '没有余额信息' },
      },
    }));

    expect(response.status).toBe(200);
    expect(sqlite.query("SELECT status FROM sim_balance_checks WHERE id='check-1'").get().status)
      .toBe('unparsed');
    expect(sqlite.query("SELECT status FROM sim_balance_skill_jobs WHERE id='job-1'").get().status)
      .toBe('stopped');
  });
});
