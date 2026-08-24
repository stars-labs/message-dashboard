import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('historical Singtel sender normalization', () => {
  test('rewrites only the two confirmed decimal ASCII sender values', async () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        phone_number TEXT,
        updated_at TEXT
      );
      INSERT INTO messages (id, type, phone_number) VALUES
        ('singtel', 'received', '83105110103116101108'),
        ('singtel-biz', 'received', '831051101031161011083266105122'),
        ('ordinary-number', 'received', '831051101031161011080'),
        ('sent-row', 'sent', '83105110103116101108');
    `);
    const migration = await Bun.file(
      new URL('./068_normalize_singtel_senders.sql', import.meta.url),
    ).text();
    database.exec(migration);

    expect(database.query(`SELECT id, phone_number FROM messages ORDER BY id`).all()).toEqual([
      { id: 'ordinary-number', phone_number: '831051101031161011080' },
      { id: 'sent-row', phone_number: '83105110103116101108' },
      { id: 'singtel', phone_number: 'Singtel' },
      { id: 'singtel-biz', phone_number: 'Singtel Biz' },
    ]);
  });
});
