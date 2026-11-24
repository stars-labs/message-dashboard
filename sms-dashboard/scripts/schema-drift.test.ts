import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { schemaDrift } from './schema-drift.ts';

function database(sql: string): Database {
  const db = new Database(':memory:');
  db.run(`
    CREATE TABLE sim_balance_profiles (id TEXT PRIMARY KEY, enabled INTEGER);
    INSERT INTO sim_balance_profiles VALUES ('cn-mobile', 1);
    ${sql}
  `);
  return db;
}

describe('schemaDrift', () => {
  test('finds nothing when both hold the same objects and reference rows', () => {
    const sql = 'CREATE TABLE calls (id TEXT PRIMARY KEY); CREATE INDEX idx_calls ON calls(id);';

    expect(schemaDrift(database(sql), database(sql))).toEqual([]);
  });

  test('ignores whitespace inside a definition', () => {
    expect(
      schemaDrift(
        database('CREATE TABLE calls (id TEXT PRIMARY KEY);'),
        database('CREATE TABLE calls (\n  id   TEXT PRIMARY KEY\n);'),
      ),
    ).toEqual([]);
  });

  test('names each object missing, extra or defined differently', () => {
    const drift = schemaDrift(
      database('CREATE TABLE calls (id TEXT); CREATE INDEX idx_calls ON calls(id);'),
      database('CREATE TABLE calls (id TEXT, ended_at TEXT); CREATE TABLE extra (id TEXT);'),
    );

    expect(drift).toEqual([
      'table calls differs:\n  baseline:   CREATE TABLE calls (id TEXT)\n  production: CREATE TABLE calls (id TEXT, ended_at TEXT)',
      'table extra is in production only',
      'index idx_calls is in the baseline only',
    ]);
  });

  test('names a reference row that differs', () => {
    const production = database('');
    production.run(`UPDATE sim_balance_profiles SET enabled = 0`);
    production.run(`INSERT INTO sim_balance_profiles VALUES ('sg-m1', 1)`);

    expect(schemaDrift(database(''), production)).toEqual([
      'sim_balance_profiles cn-mobile differs:\n  baseline:   {"id":"cn-mobile","enabled":1}\n  production: {"id":"cn-mobile","enabled":0}',
      'sim_balance_profiles sg-m1 is in production only',
    ]);
  });
});
