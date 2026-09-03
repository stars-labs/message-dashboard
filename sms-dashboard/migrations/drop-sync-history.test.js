import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';

let database;

afterEach(() => database?.close());

describe('drop obsolete device sync history', () => {
  test('removes the write-only sync_history table', () => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE sync_history (id INTEGER PRIMARY KEY, session_id TEXT);
      CREATE INDEX idx_sync_history_session ON sync_history(session_id);
    `);

    const migration = readFileSync(
      new URL('./073_drop_sync_history.sql', import.meta.url),
      'utf8',
    );
    database.exec(migration);

    expect(database.query(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_history'
    `).get()).toBeNull();
  });
});
