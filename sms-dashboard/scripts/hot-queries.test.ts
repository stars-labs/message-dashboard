import { describe, expect, test } from 'bun:test';
import { hotQueries, parseInsights, periodDays } from './hot-queries.ts';

// Production Query Insights for the 7 days before 2026-11-26, trimmed to the fields used.
const WEEK_BEFORE_FIX = [
  {
    query:
      "UPDATE messages SET status = 'failed', error_message = 'Message has no recipient or SIM to send from', updated_at = CURRENT_TIMESTAMP WHERE type = 'sent' AND status = 'sending' AND (recipient IS NULL OR phone_iccid IS NULL OR created_at IS NULL)",
    avgRowsRead: 396,
    totalRowsRead: 7005296,
    totalRowsWritten: 0,
    numberOfTimesRun: 17679,
  },
  {
    query: "UPDATE sim_balance_skill_jobs SET status = 'leased', lease_owner = ? WHERE id = (…)",
    avgRowsRead: 114,
    totalRowsRead: 982288,
    totalRowsWritten: 58,
    numberOfTimesRun: 8570,
  },
  {
    query: "SELECT id FROM ( SELECT id, purpose, created_at FROM messages WHERE type = 'sent' )",
    avgRowsRead: 5,
    totalRowsRead: 313630,
    totalRowsWritten: 0,
    numberOfTimesRun: 59333,
  },
  {
    query: 'SELECT kt.*, COUNT(DISTINCT mt.message_id) as usage_count FROM keyword_tags kt',
    avgRowsRead: 541,
    totalRowsRead: 42739,
    totalRowsWritten: 0,
    numberOfTimesRun: 79,
  },
];

describe('hot queries', () => {
  test('ranks the recurring statements that read many rows a run, most rows first', () => {
    const report = hotQueries(parseInsights(JSON.stringify(WEEK_BEFORE_FIX)), {
      days: 7,
      minRunsPerDay: 96,
      minAvgRowsRead: 50,
    });

    expect(
      report.map(({ runsPerDay, avgRowsRead, totalRowsRead }) => ({
        runsPerDay,
        avgRowsRead,
        totalRowsRead,
      })),
    ).toEqual([
      { runsPerDay: 2526, avgRowsRead: 396, totalRowsRead: 7005296 },
      { runsPerDay: 1224, avgRowsRead: 114, totalRowsRead: 982288 },
    ]);
    expect(report[0]?.query).toStartWith("UPDATE messages SET status = 'failed'");
  });

  test('leaves out a cheap poll and an occasional heavy page', () => {
    const report = hotQueries(parseInsights(JSON.stringify(WEEK_BEFORE_FIX)), {
      days: 7,
      minRunsPerDay: 96,
      minAvgRowsRead: 50,
    });

    expect(report.some(({ query }) => query.includes('keyword_tags'))).toBe(false);
    expect(report.some(({ query }) => query.startsWith('SELECT id FROM'))).toBe(false);
  });

  test('collapses whitespace so a statement reads on one line', () => {
    const [row] = hotQueries(
      parseInsights(
        JSON.stringify([{ ...WEEK_BEFORE_FIX[0], query: '\n  UPDATE messages\n    SET x = 1\n' }]),
      ),
      { days: 1, minRunsPerDay: 1, minAvgRowsRead: 1 },
    );

    expect(row?.query).toBe('UPDATE messages SET x = 1');
  });

  test('rejects output that is not a list of query insights', () => {
    expect(() => parseInsights('{"error":"not authorised"}')).toThrow('Query Insights');
    expect(() => parseInsights('not json')).toThrow('Query Insights');
  });
});

describe('insights period', () => {
  test.each([
    ['1h', 1 / 24],
    ['1d', 1],
    ['7d', 7],
    ['31d', 31],
  ])('reads %s as %d days', (period, days) => {
    expect(periodDays(period)).toBe(days);
  });

  test('rejects a period wrangler does not take', () => {
    expect(() => periodDays('2w')).toThrow('period');
  });
});
