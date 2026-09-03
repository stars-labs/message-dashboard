import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

describe('message inbox read migration', () => {
  test('uses bounded ingestion indexes for global and per-card polling', async () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        phone_iccid TEXT,
        purpose TEXT NOT NULL DEFAULT 'user',
        filter_status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const migration = await Bun.file(new URL(
      './074_optimize_message_inbox_reads.sql',
      import.meta.url,
    )).text();
    database.exec(migration);

    const globalPlan = database.query(`
      EXPLAIN QUERY PLAN
      SELECT * FROM messages
      WHERE purpose = 'user'
        AND created_at >= datetime('2026-09-02T00:00:00.000Z', '-2 seconds')
        AND filter_status IN ('pending', 'clean')
      ORDER BY created_at DESC, id DESC
      LIMIT 101
    `).all().map((row) => row.detail).join('\n');
    const cardPlan = database.query(`
      EXPLAIN QUERY PLAN
      SELECT * FROM messages
      WHERE purpose = 'user' AND phone_iccid = 'iccid-1'
        AND created_at >= datetime('2026-09-02T00:00:00.000Z', '-2 seconds')
        AND filter_status IN ('pending', 'clean')
      ORDER BY created_at DESC, id DESC
      LIMIT 101
    `).all().map((row) => row.detail).join('\n');

    expect(globalPlan).toContain('idx_messages_user_created');
    expect(cardPlan).toContain('idx_messages_iccid_user_created');
    database.close();
  });
});
