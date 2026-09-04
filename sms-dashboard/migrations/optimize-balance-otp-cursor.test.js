import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

describe('balance OTP cursor migration', () => {
  test('indexes the SIM, ingestion time, and daemon source message id', async () => {
    const sql = await Bun.file('migrations/075_optimize_balance_otp_cursor.sql').text();

    expect(sql).toContain('ON messages(phone_iccid, created_at, id)');
    expect(sql).toMatch(/WHERE\s+type\s*=\s*'received'\s+AND\s+verification_code\s+IS\s+NOT\s+NULL/i);

    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, phone_iccid TEXT, type TEXT,
          verification_code TEXT, created_at TIMESTAMP
        );
      `);
      db.exec(sql);
      const plan = db.query(`
        EXPLAIN QUERY PLAN
        SELECT id FROM messages
        WHERE phone_iccid = ? AND type = 'received'
          AND verification_code IS NOT NULL AND created_at >= ?
        ORDER BY created_at, id LIMIT 20
      `).all('iccid', '2026-09-04 10:00:00');
      expect(plan.some(({ detail }) => detail.includes('idx_messages_otp_cursor'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
