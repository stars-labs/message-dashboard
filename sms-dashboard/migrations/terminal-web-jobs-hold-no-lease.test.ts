import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

test('refuses a finished web job that still holds a lease, on insert or update', async () => {
  using database = new Database(':memory:');
  database.run(`
    CREATE TABLE sim_balance_web_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      lease_owner TEXT,
      lease_expires_at TIMESTAMP
    );
    INSERT INTO sim_balance_web_jobs (id, status, lease_owner, lease_expires_at) VALUES
      ('running', 'querying', 'runner-1', '2026-11-26 06:00:00'),
      ('done', 'completed', NULL, NULL);
  `);

  database.run(
    await Bun.file(new URL('./086_terminal_web_jobs_hold_no_lease.sql', import.meta.url)).text(),
  );

  const heldLease = 'A finished web job cannot hold a lease';
  const insert = database.query(`
    INSERT INTO sim_balance_web_jobs (id, status, lease_owner, lease_expires_at)
    VALUES ('new', ?, ?, ?)
  `);
  for (const status of ['completed', 'failed', 'stopped']) {
    expect(() => insert.run(status, 'runner-1', null)).toThrow(heldLease);
    expect(() => insert.run(status, null, '2026-11-26 06:00:00')).toThrow(heldLease);
  }
  expect(() => insert.run('leased', 'runner-1', '2026-11-26 06:00:00')).not.toThrow();

  expect(() =>
    database.run(`UPDATE sim_balance_web_jobs SET status = 'failed' WHERE id = 'running'`),
  ).toThrow(heldLease);
  expect(() =>
    database.run(`UPDATE sim_balance_web_jobs SET lease_owner = 'runner-1' WHERE id = 'done'`),
  ).toThrow(heldLease);
  expect(() =>
    database.run(`
      UPDATE sim_balance_web_jobs
      SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL
      WHERE id = 'running'
    `),
  ).not.toThrow();
});
