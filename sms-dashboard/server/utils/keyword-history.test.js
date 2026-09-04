import { describe, expect, test } from 'bun:test';
import { processKeywordHistoryPage } from './keyword-history.js';

describe('bounded keyword history processing', () => {
  test('reads one indexed page, skips ineligible messages, and inserts matches idempotently', async () => {
    const calls = [];
    const rows = [
      {
        id: 'm-1', content: 'Your code is 1234', filter_status: 'clean',
        verification_code: null, created_at: '2026-09-01 00:00:00',
      },
      {
        id: 'm-2', content: 'code in filtered mail', filter_status: 'filtered',
        verification_code: null, created_at: '2026-09-02 00:00:00',
      },
      {
        id: 'm-3', content: 'lookahead row', filter_status: 'clean',
        verification_code: null, created_at: '2026-09-03 00:00:00',
      },
    ];
    const db = {
      prepare(sql) {
        const statement = {
          sql,
          params: [],
          bind(...params) { statement.params = params; return statement; },
          async all() {
            calls.push({ operation: 'all', sql, params: statement.params });
            return { results: rows };
          },
        };
        return statement;
      },
      async batch(statements) {
        calls.push({ operation: 'batch', statements });
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    };

    const result = await processKeywordHistoryPage(db, {
      id: 7,
      keyword: 'code',
      case_sensitive: 0,
      whole_word: 0,
    }, {
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-04T00:00:00.000Z',
      pageSize: 2,
    });

    const pageRead = calls.find(({ operation }) => operation === 'all');
    expect(pageRead.sql).toContain("purpose = 'user'");
    expect(pageRead.sql).toContain('ORDER BY created_at, id');
    expect(pageRead.sql).not.toMatch(/instr\s*\(|LIKE|verification_code IS NULL|filter_status\s*[=<>]/i);
    expect(pageRead.params.at(-1)).toBe(3);

    const writes = calls.find(({ operation }) => operation === 'batch').statements;
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('INSERT OR IGNORE INTO message_tags');
    expect(writes[0].params).toEqual(['m-1', 7, 'code', 5]);
    expect(result).toEqual({
      processed: 2,
      eligible: 1,
      matched_messages: 1,
      inserted: 1,
      has_more: true,
      next_cursor: { created_at: rows[1].created_at, id: rows[1].id },
    });
  });

  test('uses the stable cursor and propagates D1 failures', async () => {
    const db = {
      prepare(sql) {
        const statement = {
          bind(...params) { statement.params = params; return statement; },
          async all() {
            expect(sql).toContain('(created_at > ? OR (created_at = ? AND id > ?))');
            expect(statement.params.slice(2, 5)).toEqual([
              '2026-09-02 00:00:00', '2026-09-02 00:00:00', 'm-2',
            ]);
            throw new Error('D1 unavailable');
          },
        };
        return statement;
      },
    };

    await expect(processKeywordHistoryPage(db, {
      id: 7, keyword: 'code', case_sensitive: 0, whole_word: 0,
    }, {
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-04T00:00:00.000Z',
      cursor: { created_at: '2026-09-02 00:00:00', id: 'm-2' },
    })).rejects.toThrow('D1 unavailable');
  });
});
