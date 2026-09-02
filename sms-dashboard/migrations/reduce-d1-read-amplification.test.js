import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

describe('D1 read-amplification migration', () => {
  test('bounds outbound polling, recovery, and recent balance history reads', async () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT,
        purpose TEXT NOT NULL DEFAULT 'user',
        processing_session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sim_balance_checks (
        id TEXT PRIMARY KEY,
        requested_at TIMESTAMP NOT NULL
      );
    `);

    const migration = await Bun.file(new URL(
      './072_reduce_d1_read_amplification.sql',
      import.meta.url,
    )).text();
    database.exec(migration);

    const pendingPlan = database.query(`
      EXPLAIN QUERY PLAN
      SELECT id, purpose, created_at
      FROM messages
      WHERE type = 'sent' AND status = 'sending'
      ORDER BY purpose, created_at, id
    `).all().map((row) => row.detail).join('\n');
    const recoveryPlan = database.query(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM messages
      WHERE type = 'sent' AND status = 'processing'
        AND processing_session_id <> 'current-session'
    `).all().map((row) => row.detail).join('\n');
    const balancePlan = database.query(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM sim_balance_checks
      ORDER BY requested_at DESC
      LIMIT 100
    `).all().map((row) => row.detail).join('\n');

    expect(pendingPlan).toContain('idx_messages_pending_outbound');
    expect(recoveryPlan).toContain('idx_messages_processing_outbound');
    expect(balancePlan).toContain('idx_balance_checks_requested');
    database.close();
  });
});
