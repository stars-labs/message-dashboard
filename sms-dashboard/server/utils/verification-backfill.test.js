import { describe, expect, test } from 'bun:test';
import { FILTER_STATUS } from './spam-filter.js';
import { reprocessVerificationPage } from './verification-backfill.js';

function fakeDb(seed) {
  const rows = seed.map((row, index) => ({ row_cursor: index + 1, ...row }));

  return {
    rows,
    prepare(sql) {
      if (sql.includes('SELECT rowid AS row_cursor')) {
        return {
          bind(after, limit) {
            return {
              async all() {
                return {
                  results: rows.filter((row) => row.row_cursor > after).slice(0, limit),
                };
              },
            };
          },
        };
      }

      if (sql.includes('UPDATE messages')) {
        return {
          bind(code, filterStatus, id) {
            return { code, filterStatus, id };
          },
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async batch(statements) {
      for (const statement of statements) {
        const row = rows.find((candidate) => candidate.id === statement.id);
        row.verification_code = statement.code;
        row.filter_status = statement.filterStatus;
        row.filter_rule_id = null;
      }
    },
  };
}

describe('reprocessVerificationPage', () => {
  test('removes loose false positives and queues changed rows for spam reclassification', async () => {
    const db = fakeDb([
      {
        id: 'marketing',
        content: 'M1 upgrade available on 9 August 2026',
        verification_code: '2026',
        filter_status: 'clean',
      },
      {
        id: 'otp',
        content: 'Your OTP is 4821',
        verification_code: '4821',
        filter_status: 'clean',
      },
    ]);

    const result = await reprocessVerificationPage(db);

    expect(result).toMatchObject({ processed: 2, changed: 1, removed: 1, done: true });
    expect(db.rows[0].verification_code).toBeNull();
    expect(db.rows[0].filter_status).toBe(FILTER_STATUS.PENDING);
    expect(db.rows[1].filter_status).toBe('clean');
  });

  test('dry-run reports changes without writing them', async () => {
    const db = fakeDb([
      { id: 'card', content: '您的尾号9016卡片即将到期', verification_code: '9016' },
    ]);

    const result = await reprocessVerificationPage(db, { dryRun: true });

    expect(result).toMatchObject({ changed: 1, removed: 1, dry_run: true });
    expect(db.rows[0].verification_code).toBe('9016');
  });

  test('returns a cursor for bounded, resumable pages', async () => {
    const db = fakeDb([
      { id: '1', content: 'nothing', verification_code: null },
      { id: '2', content: 'nothing', verification_code: null },
      { id: '3', content: 'nothing', verification_code: null },
    ]);

    const first = await reprocessVerificationPage(db, { pageSize: 2 });
    const second = await reprocessVerificationPage(db, { after: first.next_cursor, pageSize: 2 });

    expect(first).toMatchObject({ processed: 2, next_cursor: 2, done: false });
    expect(second).toMatchObject({ processed: 1, next_cursor: 3, done: true });
  });
});
