import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { balanceRunnersHandler, loadBalanceRunnerStatus } from './balance-runners.js';

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const database = this.database;
    const execute = (params = []) => ({
      first: async () => database.query(sql).get(...params) || null,
      all: async () => ({ results: database.query(sql).all(...params) }),
      run: async () => {
        database.query(sql).run(...params);
        return { meta: { changes: database.query('SELECT changes() AS value').get().value } };
      },
      sql,
      params,
    });
    return {
      ...execute(),
      bind(...params) {
        return execute(params);
      },
    };
  }

  async batch(statements) {
    const database = this.database;
    return this.database.transaction(() => statements.map((statement) => {
      this.database.query(statement.sql).run(...statement.params);
      return { meta: { changes: database.query('SELECT changes() AS value').get().value } };
    }))();
  }
}

function request(db, body, apiKey = 'secret') {
  return {
    env: { API_KEY: 'secret', DB: db },
    headers: new Headers({ 'X-API-Key': apiKey }),
    json: async () => body,
  };
}

describe('balance runner control plane', () => {
  let sqlite;
  let db;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec(await Bun.file('migrations/055_add_balance_runner_control_plane.sql').text());
    db = new D1Adapter(sqlite);
  });

  afterEach(() => sqlite.close());

  test('checks runner credentials without changing control-plane state', async () => {
    const response = await balanceRunnersHandler.check(request(db, null));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(sqlite.query('SELECT COUNT(*) AS count FROM balance_runner_installations').get().count).toBe(0);

    const unauthorized = await balanceRunnersHandler.check(request(db, null, 'wrong'));
    expect(unauthorized.status).toBe(401);
  });

  test('registers a legacy runner heartbeat without storing a credential', async () => {
    const response = await balanceRunnersHandler.heartbeat(request(db, {
      runner_id: 'workstation-legacy',
      session_id: 'session-1',
      display_name: 'Workstation',
      platform: 'darwin',
      version: 'development',
      capabilities: [{
        capability: 'sms_ai', state: 'ready', concurrency: 1,
        current_job_id: null, detail_code: null,
      }],
    }));

    expect(response.status).toBe(200);
    expect(sqlite.query(`
      SELECT id, auth_mode, auth_subject FROM balance_runner_installations
    `).get()).toEqual({
      id: 'workstation-legacy', auth_mode: 'legacy_api_key', auth_subject: null,
    });
    expect(sqlite.query(`
      SELECT capability, state, session_id FROM balance_runner_capabilities
    `).get()).toEqual({ capability: 'sms_ai', state: 'ready', session_id: 'session-1' });
  });

  test('rejects unknown capabilities and invalid concurrency', async () => {
    const base = {
      runner_id: 'runner-1', session_id: 'session-1', display_name: 'Runner',
      platform: 'darwin', version: '1.0.0',
    };
    let response = await balanceRunnersHandler.heartbeat(request(db, {
      ...base,
      capabilities: [{ capability: 'shell', state: 'ready', concurrency: 1 }],
    }));
    expect(response.status).toBe(400);

    response = await balanceRunnersHandler.heartbeat(request(db, {
      ...base,
      capabilities: [{ capability: 'sms_ai', state: 'ready', concurrency: 99 }],
    }));
    expect(response.status).toBe(400);
  });

  test('does not allow a revoked installation to return by heartbeat', async () => {
    sqlite.exec(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, platform, version, revoked_at
      ) VALUES ('runner-1', 'Runner', 'legacy_api_key', 'darwin', '1', CURRENT_TIMESTAMP)
    `);
    const response = await balanceRunnersHandler.heartbeat(request(db, {
      runner_id: 'runner-1', session_id: 'session-1', display_name: 'Runner',
      platform: 'darwin', version: '1',
      capabilities: [{ capability: 'sms_ai', state: 'ready', concurrency: 1 }],
    }));
    expect(response.status).toBe(403);
    expect(sqlite.query('SELECT COUNT(*) AS count FROM balance_runner_capabilities').get().count).toBe(0);
  });

  test('does not let the legacy credential overwrite a device-owned runner ID', async () => {
    sqlite.exec(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version
      ) VALUES ('runner-1', 'Runner', 'auth0_device', 'auth0|device-1', 'darwin', '1')
    `);
    const response = await balanceRunnersHandler.heartbeat(request(db, {
      runner_id: 'runner-1', session_id: 'session-1', display_name: 'Runner',
      platform: 'darwin', version: '1',
      capabilities: [{ capability: 'sms_ai', state: 'ready', concurrency: 1 }],
    }));
    expect(response.status).toBe(409);
    expect(sqlite.query(`
      SELECT auth_mode, auth_subject FROM balance_runner_installations WHERE id = 'runner-1'
    `).get()).toEqual({ auth_mode: 'auth0_device', auth_subject: 'auth0|device-1' });
  });

  test('reports ready capabilities and expires stale heartbeats', async () => {
    sqlite.exec(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, platform, version, last_heartbeat
      ) VALUES
        ('online', 'Online', 'legacy_api_key', 'darwin', '1', CURRENT_TIMESTAMP),
        ('stale', 'Stale', 'legacy_api_key', 'darwin', '1', datetime('now', '-120 seconds'));
      INSERT INTO balance_runner_capabilities (
        runner_id, capability, state, session_id, last_heartbeat
      ) VALUES
        ('online', 'sms_ai', 'ready', 'session-1', CURRENT_TIMESTAMP),
        ('stale', 'unicom_browser', 'ready', 'session-2', datetime('now', '-120 seconds'));
    `);

    const status = await loadBalanceRunnerStatus(db);
    expect(status.capabilities.sms_ai.available).toBe(true);
    expect(status.capabilities.unicom_browser).toMatchObject({ available: false, state: 'offline' });
    expect(status.runners.find((runner) => runner.id === 'stale').online).toBe(false);
  });

  test('reports only runners owned by the requested Auth0 subject', async () => {
    sqlite.exec(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version
      ) VALUES
        ('alice', 'Alice Agent', 'auth0_device', 'auth0|alice', 'darwin', '1'),
        ('bob', 'Bob Agent', 'auth0_device', 'auth0|bob', 'darwin', '1'),
        ('legacy', 'Legacy', 'legacy_api_key', NULL, 'darwin', '1');
      INSERT INTO balance_runner_capabilities (
        runner_id, capability, state, session_id
      ) VALUES
        ('alice', 'sms_ai', 'ready', 'alice-session'),
        ('bob', 'unicom_browser', 'ready', 'bob-session'),
        ('legacy', 'unicom_browser', 'ready', 'legacy-session');
    `);

    const status = await loadBalanceRunnerStatus(db, { authSubject: 'auth0|alice' });
    expect(status.runners.map((runner) => runner.id)).toEqual(['alice']);
    expect(status.capabilities.sms_ai.available).toBe(true);
    expect(status.capabilities.unicom_browser.available).toBe(false);
  });
});
