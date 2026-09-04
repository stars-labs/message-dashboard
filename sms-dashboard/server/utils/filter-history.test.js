import { describe, expect, test } from 'bun:test';
import { processRuleHistoryPage } from './filter-history.js';

describe('bounded filter history processing', () => {
  test('writes only changed final verdicts and returns a stable page cursor', async () => {
    const calls = [];
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `m-${index + 1}`,
      type: 'received',
      content: 'ordinary marketing',
      phone_number: index === 1 ? '13910086' : `10655446${index}`,
      filter_status: 'clean',
      filter_rule_id: null,
      created_at: `2026-09-0${index + 1} 00:00:00`,
    }));
    const db = {
      prepare(sql) {
        const statement = {
          params: [],
          bind(...params) { statement.params = params; return statement; },
          async all() {
            calls.push({ operation: 'all', sql, params: statement.params });
            if (sql.includes('FROM filter_rules')) {
              return { results: [{ id: 9, rule_type: 'sender', pattern: '10655446', is_active: 1 }] };
            }
            return { results: rows };
          },
        };
        return statement;
      },
      async batch(statements) {
        calls.push({ operation: 'batch', statements });
        return statements.map(() => ({ success: true }));
      },
    };

    const result = await processRuleHistoryPage(db, {
      id: 9,
      rule_type: 'sender',
      pattern: '10655446',
      is_active: 1,
    }, {
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-04T00:00:00.000Z',
      pageSize: 2,
    });

    const candidateQuery = calls.find(({ sql }) => sql?.includes('FROM messages'));
    expect(candidateQuery.sql).toContain('verification_code IS NULL');
    expect(candidateQuery.sql).toContain("filter_status <> 'filtered'");
    expect(candidateQuery.sql).toContain('created_at >= datetime(?)');
    expect(candidateQuery.params.at(-1)).toBe(3);
    expect(calls.some(({ sql }) => /SET filter_status = ['"]pending/i.test(sql || ''))).toBe(false);
    expect(calls.find(({ operation }) => operation === 'batch').statements).toHaveLength(1);
    expect(result).toEqual({
      mode: 'apply',
      processed: 2,
      changed: 1,
      has_more: true,
      next_cursor: { created_at: rows[1].created_at, id: rows[1].id },
    });
  });
});
