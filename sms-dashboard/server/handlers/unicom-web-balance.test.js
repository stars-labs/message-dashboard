import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unicomWebBalanceHandler } from './unicom-web-balance.js';

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
      return { meta: { changes: this.database.query('SELECT changes() AS value').get().value } };
    }))();
  }
}

function request(db, { id = null, runnerId = 'runner-1', body = null } = {}) {
  return {
    env: { API_KEY: 'secret', DB: db },
    headers: new Headers({ 'X-API-Key': 'secret' }),
    url: `https://example.com/api/control/unicom-web-balance/jobs/claim?runner_id=${runnerId}`,
    params: id ? { id } : {},
    json: async () => body,
  };
}

describe('China Unicom browser balance job protocol', () => {
  let sqlite;
  let db;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sims (iccid TEXT PRIMARY KEY, number TEXT, sim_index INTEGER);
      CREATE VIEW device_view AS SELECT iccid, number, sim_index FROM sims;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, phone_iccid TEXT, phone_number TEXT, content TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, type TEXT,
        verification_code TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_profiles (
        id TEXT PRIMARY KEY, country_code TEXT, carrier TEXT, method TEXT,
        command TEXT, destination TEXT, expected_senders TEXT, parser_version TEXT,
        response_window_minutes INTEGER, discovery_enabled INTEGER, enabled INTEGER,
        conversation_steps TEXT DEFAULT '[]', skill_config TEXT DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_checks (
        id TEXT PRIMARY KEY, sim_iccid TEXT, profile_id TEXT,
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, sent_at TIMESTAMP,
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
      INSERT INTO sims VALUES ('iccid-1', '+8617600419127', 1);
    `);
    sqlite.exec(await Bun.file('migrations/054_add_unicom_web_balance_skill.sql').text());
    sqlite.exec(`
      INSERT INTO sim_balance_checks (
        id, sim_iccid, profile_id, status, parser_version
      ) VALUES (
        'check-1', 'iccid-1', 'cn-unicom-browser-random-password-v1',
        'queued', 'cn-unicom-web-balance-v1'
      );
      INSERT INTO sim_balance_web_jobs (id, check_id, provider)
      VALUES ('job-1', 'check-1', 'china_unicom');
    `);
    db = new D1Adapter(sqlite);
  });

  afterEach(() => sqlite.close());

  async function claim() {
    const response = await unicomWebBalanceHandler.claim(request(db));
    expect(response.status).toBe(200);
    return response.json();
  }

  test('leases a browser job without exposing carrier credentials', async () => {
    const job = await claim();
    expect(job.sim_number).toBe('+8617600419127');
    expect(job.login_url).toContain('10010.com');
    expect(job.otp_requested_at).toBeNull();
    expect(JSON.stringify(job)).not.toContain('cookie');
    expect(sqlite.query("SELECT status FROM sim_balance_web_jobs WHERE id='job-1'").get().status)
      .toBe('leased');
  });

  test('does not let a legacy runner claim a Dashboard-owned browser job', async () => {
    sqlite.exec("UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'");

    const response = await unicomWebBalanceHandler.claim(request(db));
    expect(response.status).toBe(204);
    expect(sqlite.query("SELECT status FROM sim_balance_web_jobs WHERE id='job-1'").get().status)
      .toBe('pending');
  });

  test('returns only an OTP from the same SIM, allowlisted sender and request window', async () => {
    const job = await claim();
    await unicomWebBalanceHandler.otpRequested(request(db, {
      id: job.id,
      body: { runner_id: 'runner-1' },
    }));
    sqlite.exec(`
      INSERT INTO messages VALUES (
        'wrong-context', 'iccid-1', '10010', '优惠码123456', CURRENT_TIMESTAMP,
        'received', '123456', CURRENT_TIMESTAMP
      );
      INSERT INTO messages VALUES (
        'right', 'iccid-1', '+8610010', '您的随机密码为654321，请勿泄露', CURRENT_TIMESTAMP,
        'received', '654321', CURRENT_TIMESTAMP
      );
    `);
    const response = await unicomWebBalanceHandler.otp(request(db, {
      id: job.id,
      runnerId: 'runner-1',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: '654321' });
  });

  test('extends the lease while waiting for human verification', async () => {
    const job = await claim();
    const response = await unicomWebBalanceHandler.heartbeat(request(db, {
      id: job.id,
      body: {
        runner_id: 'runner-1',
        status: 'human_verification_required',
        reason: '请完成滑块验证',
      },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ lease_seconds: 900 });
    expect(sqlite.query("SELECT status, human_reason FROM sim_balance_web_jobs WHERE id='job-1'").get())
      .toEqual({
        status: 'human_verification_required',
        human_reason: '请完成滑块验证',
      });
  });

  test('stores a balance only for the task account', async () => {
    const job = await claim();
    const mismatch = await unicomWebBalanceHandler.complete(request(db, {
      id: job.id,
      body: {
        runner_id: 'runner-1', balance: 18.25, currency: 'CNY',
        account_number: '+8618600000000',
      },
    }));
    expect(mismatch.status).toBe(409);

    const response = await unicomWebBalanceHandler.complete(request(db, {
      id: job.id,
      body: {
        runner_id: 'runner-1', balance: 18.25, currency: 'CNY',
        account_number: '+8617600419127',
      },
    }));
    expect(response.status).toBe(200);
    expect(sqlite.query("SELECT status FROM sim_balance_checks WHERE id='check-1'").get().status)
      .toBe('parsed');
    expect(sqlite.query("SELECT value, currency FROM sim_balance_metrics WHERE check_id='check-1'").get())
      .toEqual({ value: 18.25, currency: 'CNY' });
  });

  test('does not requeue a browser login after an OTP was requested', async () => {
    const job = await claim();
    await unicomWebBalanceHandler.otpRequested(request(db, {
      id: job.id,
      body: { runner_id: 'runner-1' },
    }));
    const response = await unicomWebBalanceHandler.release(request(db, {
      id: job.id,
      body: { runner_id: 'runner-1', error: 'Browser closed' },
    }));
    expect(await response.json()).toEqual({ success: true, status: 'failed' });
    expect(sqlite.query("SELECT status FROM sim_balance_web_jobs WHERE id='job-1'").get().status)
      .toBe('failed');
    expect(sqlite.query("SELECT status FROM sim_balance_checks WHERE id='check-1'").get().status)
      .toBe('failed');
  });
});
