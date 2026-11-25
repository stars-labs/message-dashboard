import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

// createSchema and every seed pass several statements to Database.run. Bun 1.4.2
// skipped a statement that failed while running whenever any SQL followed it.
describe('Database.run with several statements', () => {
  const FAILS_WHILE_RUNNING = 'SELECT abs(-9223372036854775808);';

  function userVersion(db: Database): unknown {
    return db.query('PRAGMA user_version').get();
  }

  test('throws when the failing statement is followed only by whitespace', () => {
    const db = new Database(':memory:');

    expect(() => {
      db.run(`
        PRAGMA user_version = 1;
        ${FAILS_WHILE_RUNNING}
      `);
    }).toThrow('integer overflow');
  });

  test('throws at the failing statement and runs none after it', () => {
    const db = new Database(':memory:');

    expect(() => {
      db.run(`PRAGMA user_version = 1; ${FAILS_WHILE_RUNNING} PRAGMA user_version = 2;`);
    }).toThrow('integer overflow');
    expect(userVersion(db)).toEqual({ user_version: 1 });
  });
});
