import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

describe('balance runtime migration', () => {
  let sqlite;
  afterEach(() => sqlite?.close());

  test('materializes deadlines and adds bounded runtime indexes', async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sim_balance_profiles (id TEXT PRIMARY KEY, response_window_minutes INTEGER);
      CREATE TABLE sim_balance_checks (
        id TEXT PRIMARY KEY, profile_id TEXT, status TEXT,
        requested_at TIMESTAMP, sent_at TIMESTAMP
      );
      CREATE TABLE sim_balance_web_jobs (
        id TEXT PRIMARY KEY, status TEXT, attempts INTEGER,
        lease_expires_at TIMESTAMP, created_at TIMESTAMP
      );
      INSERT INTO sim_balance_profiles VALUES ('profile', 30);
      INSERT INTO sim_balance_checks VALUES (
        'check', 'profile', 'awaiting_response',
        '2026-09-04 10:00:00', '2026-09-04 10:01:00'
      );
    `);

    sqlite.exec(await Bun.file('migrations/076_optimize_balance_runtime.sql').text());

    expect(sqlite.query("SELECT deadline_at FROM sim_balance_checks WHERE id='check'").get())
      .toEqual({ deadline_at: '2026-09-04 10:31:00' });
    const indexes = sqlite.query(`
      SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
    `).all().map(({ name }) => name);
    expect(indexes).toContain('idx_balance_checks_status_deadline');
    expect(indexes).toContain('idx_balance_web_jobs_pending_claim');
    const claimPlan = sqlite.query(`
      EXPLAIN QUERY PLAN
      SELECT id FROM sim_balance_web_jobs
      WHERE status = 'pending' AND attempts < 3
      ORDER BY created_at, id LIMIT 1
    `).all();
    expect(claimPlan.some(({ detail }) => detail.includes('idx_balance_web_jobs_pending_claim')))
      .toBe(true);
  });
});
