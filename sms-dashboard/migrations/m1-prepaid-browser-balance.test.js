import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('M1 prepaid browser balance migration', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sims (iccid TEXT PRIMARY KEY, number TEXT, sim_index INTEGER);
      CREATE VIEW device_view AS SELECT iccid, number, sim_index FROM sims;
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE sim_balance_profiles (
        id TEXT PRIMARY KEY, country_code TEXT, carrier TEXT, method TEXT,
        command TEXT, destination TEXT, expected_senders TEXT, parser_version TEXT,
        response_window_minutes INTEGER, discovery_enabled INTEGER, enabled INTEGER,
        conversation_steps TEXT DEFAULT '[]', skill_config TEXT DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_checks (id TEXT PRIMARY KEY);
    `);
    db.exec(await Bun.file('migrations/054_add_unicom_web_balance_skill.sql').text());
    db.exec(await Bun.file('migrations/055_add_balance_runner_control_plane.sql').text());
    db.exec(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, platform, version
      ) VALUES ('runner-1', 'Runner', 'legacy_api_key', 'darwin', '1');
      INSERT INTO balance_runner_capabilities (
        runner_id, capability, state, session_id
      ) VALUES ('runner-1', 'unicom_browser', 'ready', 'session-1');
      INSERT INTO sim_balance_checks VALUES ('check-1');
      INSERT INTO sim_balance_web_jobs (id, check_id, provider)
      VALUES ('job-1', 'check-1', 'china_unicom');
      INSERT INTO sim_balance_web_events (job_id, event_type)
      VALUES ('job-1', 'queued');
    `);
    db.exec(await Bun.file('migrations/065_add_m1_prepaid_browser_balance.sql').text());
  });

  afterEach(() => db.close());

  test('renames the shared browser capability and preserves existing jobs', () => {
    expect(db.query(`
      SELECT capability FROM balance_runner_capabilities WHERE runner_id = 'runner-1'
    `).get()).toEqual({ capability: 'carrier_browser' });
    expect(db.query(`
      SELECT provider, status FROM sim_balance_web_jobs WHERE id = 'job-1'
    `).get()).toEqual({ provider: 'china_unicom', status: 'pending' });
    expect(db.query(`
      SELECT event_type FROM sim_balance_web_events WHERE job_id = 'job-1'
    `).get()).toEqual({ event_type: 'queued' });
  });

  test('adds a discovery-only prepaid M1 profile that promises balance and expiry', () => {
    const profile = db.query(`
      SELECT country_code, carrier, method, command, expected_senders,
             parser_version, discovery_enabled, enabled, skill_config
      FROM sim_balance_profiles WHERE id = 'sg-m1-prepaid-browser-v1'
    `).get();
    expect(profile).toMatchObject({
      country_code: 'SG',
      carrier: 'M1',
      method: 'browser',
      command: 'https://mcardaccount.m1.com.sg/login',
      expected_senders: '["M1 Limited"]',
      parser_version: 'sg-m1-prepaid-web-balance-v1',
      discovery_enabled: 1,
      enabled: 0,
    });
    expect(JSON.parse(profile.skill_config)).toMatchObject({
      id: 'm1-prepaid-web-balance',
      required_service_type: 'prepaid',
      outputs: ['cash_balance', 'account_expiry'],
    });
  });

  test('accepts M1 jobs and rejects the retired capability name', () => {
    db.exec("INSERT INTO sim_balance_checks VALUES ('check-2')");
    expect(() => db.exec(`
      INSERT INTO sim_balance_web_jobs (id, check_id, provider)
      VALUES ('job-2', 'check-2', 'm1_prepaid')
    `)).not.toThrow();
    expect(() => db.exec(`
      INSERT INTO balance_runner_capabilities (
        runner_id, capability, state, session_id
      ) VALUES ('runner-1', 'unicom_browser', 'ready', 'old-session')
    `)).toThrow();
  });
});
