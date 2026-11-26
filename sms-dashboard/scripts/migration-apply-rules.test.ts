import { describe, expect, test } from 'bun:test';
import {
  countChanges,
  limitViolations,
  migrationToApply,
  parseBookmark,
  touchedTables,
  withBaselineHeader,
} from './migration-apply-rules.ts';

describe('migrationToApply', () => {
  const names = ['085_a.sql', '086_b.sql', '087_c.sql', '088_d.sql', 'schema.sql'];

  test('names the next migration after the baseline', () => {
    expect(migrationToApply(names, 86, '087')).toBe('087_c.sql');
  });

  test('refuses one that skips the next', () => {
    expect(() => migrationToApply(names, 86, '088')).toThrow('087_c.sql comes first');
  });

  test('refuses one the baseline already includes', () => {
    expect(() => migrationToApply(names, 86, '086')).toThrow('already in the baseline');
  });

  test('refuses a number with no migration', () => {
    expect(() => migrationToApply(names, 88, '089')).toThrow('No migration 089');
  });
});

describe('withBaselineHeader', () => {
  const schema = `-- The production schema. Generated, do not edit:
--   wrangler d1 export …
-- through: 086
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE old (id INTEGER);
`;

  test('puts the header back on an export and moves through on', () => {
    expect(
      withBaselineHeader(
        schema,
        'PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE new (id INTEGER);\n',
        87,
      ),
    ).toBe(`-- The production schema. Generated, do not edit:
--   wrangler d1 export …
-- through: 087
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE new (id INTEGER);
`);
  });

  test('keeps a header without a through line as it is', () => {
    expect(
      withBaselineHeader('-- rows\nINSERT INTO a VALUES (1);\n', 'INSERT INTO a VALUES (2);\n', 87),
    ).toBe('-- rows\nINSERT INTO a VALUES (2);\n');
  });
});

describe('limitViolations', () => {
  test('passes a rehearsal inside both limits', () => {
    expect(
      limitViolations({ rowsRead: 10, rowsWritten: 2 }, { maxRowsRead: 100, maxRowsWritten: 50 }),
    ).toEqual([]);
  });

  test('names each limit a rehearsal exceeds, with the flag that raises it', () => {
    expect(
      limitViolations(
        { rowsRead: 900, rowsWritten: 307242 },
        { maxRowsRead: 100, maxRowsWritten: 50000 },
      ),
    ).toEqual([
      'The rehearsal read 900 rows, above the limit of 100 (--max-rows-read).',
      'The rehearsal wrote 307242 rows, above the limit of 50000 (--max-rows-written).',
    ]);
  });
});

describe('parseBookmark', () => {
  test('reads the bookmark from wrangler d1 time-travel info', () => {
    expect(
      parseBookmark(
        "🚧 Time Traveling...\n⚠️ The current bookmark is '000018c8-000001b4-0000512f-5ffb0b9a'\n",
      ),
    ).toBe('000018c8-000001b4-0000512f-5ffb0b9a');
  });

  test('refuses output without one', () => {
    expect(() => parseBookmark('nothing here')).toThrow('bookmark');
  });
});

describe('touchedTables', () => {
  test('lists the tables a migration writes, by their final names', () => {
    expect(
      touchedTables([
        'CREATE TABLE messages_new (id TEXT);',
        'INSERT INTO messages_new SELECT * FROM messages;',
        'DROP TABLE messages;',
        'ALTER TABLE messages_new RENAME TO messages;',
        "UPDATE sims SET carrier = 'x' WHERE 0;",
        'DELETE FROM "alert_state" WHERE 0;',
        'CREATE TRIGGER t BEFORE INSERT ON calls BEGIN SELECT 1; END;',
      ]),
    ).toEqual(['alert_state', 'messages', 'sims']);
  });
});

describe('countChanges', () => {
  test('compares the rows production gained with the rehearsal', () => {
    expect(
      countChanges(
        { before: { messages: 100, sims: 5 }, after: { messages: 100, sims: 3 } },
        { before: { messages: 200, sims: 5, gone: 4 }, after: { messages: 202, sims: 3 } },
      ),
    ).toEqual([
      { table: 'gone', production: -4, rehearsal: 0 },
      { table: 'messages', production: 2, rehearsal: 0 },
      { table: 'sims', production: -2, rehearsal: -2 },
    ]);
  });
});
