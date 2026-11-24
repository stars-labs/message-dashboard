import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch, D1Statement } from '../lib/d1.js';
import { FILTER_STATUS } from './spam-filter.js';
import { reprocessVerificationPage } from './verification-backfill.js';

interface Seed {
  id: string;
  content: string;
  verification_code?: string | null;
  filter_status?: string;
  filter_rule_id?: number | null;
  type?: string;
}

const StoredRow = v.object({
  id: v.string(),
  verification_code: v.nullable(v.string()),
  filter_status: v.string(),
  filter_rule_id: v.nullable(v.number()),
  updated_at: v.nullable(v.string()),
});

function fakeDb(seed: Seed[]) {
  const d1 = sqliteD1();
  d1.db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT CHECK(type IN ('received', 'sent')) NOT NULL,
    verification_code TEXT,
    filter_status TEXT NOT NULL DEFAULT 'pending',
    filter_rule_id INTEGER,
    updated_at TIMESTAMP
  )`);
  const insert = d1.db.query(
    `INSERT INTO messages (id, content, type, verification_code, filter_status, filter_rule_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of seed) {
    insert.run(
      row.id,
      row.content,
      row.type ?? 'received',
      row.verification_code ?? null,
      row.filter_status ?? 'pending',
      row.filter_rule_id ?? null,
    );
  }

  const stored = (id: string) =>
    v.parse(
      StoredRow,
      d1.db
        .query(
          'SELECT id, verification_code, filter_status, filter_rule_id, updated_at FROM messages WHERE id = ?',
        )
        .get(id),
    );

  return { db: d1, stored };
}

describe('reprocessVerificationPage', () => {
  test('removes loose false positives and queues changed rows for spam reclassification', async () => {
    const { db, stored } = fakeDb([
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
    expect(stored('marketing').verification_code).toBeNull();
    expect(stored('marketing').filter_status).toBe(FILTER_STATUS.PENDING);
    expect(stored('marketing').updated_at).not.toBeNull();
    expect(stored('otp').filter_status).toBe('clean');
    expect(stored('otp').updated_at).toBeNull();
  });

  test('dry-run reports changes without writing them', async () => {
    const { db, stored } = fakeDb([
      { id: 'card', content: '您的尾号9016卡片即将到期', verification_code: '9016' },
    ]);

    const result = await reprocessVerificationPage(db, { dryRun: true });

    expect(result).toMatchObject({ changed: 1, removed: 1, dry_run: true });
    expect(stored('card').verification_code).toBe('9016');
  });

  test('adds a code to an existing WhatsApp message', async () => {
    const { db, stored } = fakeDb([
      {
        id: 'whatsapp',
        content: "<#> Your WhatsApp code: 367-140 Don't share this code with others 4sgLq1p5sV6",
        verification_code: null,
        filter_status: 'clean',
      },
    ]);

    const result = await reprocessVerificationPage(db);

    expect(result).toMatchObject({ changed: 1, added: 1, done: true });
    expect(stored('whatsapp').verification_code).toBe('367-140');
    expect(stored('whatsapp').filter_status).toBe(FILTER_STATUS.PENDING);
  });

  test('restores a filtered M1 selfcare OTP for reclassification', async () => {
    const { db, stored } = fakeDb([
      {
        id: 'm1-selfcare',
        content: 'OTP for login to selfcare portal is 159571',
        verification_code: null,
        filter_status: FILTER_STATUS.FILTERED,
        filter_rule_id: 32,
      },
    ]);

    const result = await reprocessVerificationPage(db);

    expect(result).toMatchObject({ changed: 1, added: 1, done: true });
    expect(stored('m1-selfcare').verification_code).toBe('159571');
    expect(stored('m1-selfcare').filter_status).toBe(FILTER_STATUS.PENDING);
    expect(stored('m1-selfcare').filter_rule_id).toBeNull();
  });

  test('returns a cursor for bounded, resumable pages', async () => {
    const { db } = fakeDb([
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

describe('reprocessVerificationPage scan', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id, content: 'nothing' }));

  test('reads only received messages', async () => {
    const { db, stored } = fakeDb([
      { id: 'sent', content: 'nothing', verification_code: '1234', type: 'sent' },
      { id: 'received', content: 'nothing', verification_code: '1234' },
    ]);

    const result = await reprocessVerificationPage(db);

    expect(result).toMatchObject({ processed: 1, changed: 1 });
    expect(stored('sent').verification_code).toBe('1234');
    expect(stored('received').verification_code).toBeNull();
  });

  test('resumes after the cursor, which may arrive as text', async () => {
    const { db } = fakeDb(rows);

    expect(await reprocessVerificationPage(db, { after: 2 })).toMatchObject({
      processed: 2,
      next_cursor: 4,
    });
    expect(await reprocessVerificationPage(db, { after: '3' })).toMatchObject({
      processed: 1,
      next_cursor: 4,
    });
  });

  test('restarts from the beginning for a cursor that is not a non-negative integer', async () => {
    const { db } = fakeDb(rows);

    for (const after of [-1, 1.5, 'abc', Number.NaN, null, undefined, {}]) {
      expect(await reprocessVerificationPage(db, { after })).toMatchObject({ processed: 4 });
    }
  });

  test('keeps the cursor where it was when nothing is left', async () => {
    const { db } = fakeDb(rows);

    expect(await reprocessVerificationPage(db, { after: 4 })).toMatchObject({
      processed: 0,
      next_cursor: 4,
      done: true,
    });
  });

  test('reads the page size as an integer between 1 and 500 and defaults a bad one', async () => {
    const { db } = fakeDb(rows);

    expect(await reprocessVerificationPage(db, { pageSize: '2' })).toMatchObject({ processed: 2 });
    expect(await reprocessVerificationPage(db, { pageSize: '1.9' })).toMatchObject({
      processed: 1,
    });
    expect(await reprocessVerificationPage(db, { pageSize: -5 })).toMatchObject({ processed: 1 });
    expect(await reprocessVerificationPage(db, { pageSize: 'many' })).toMatchObject({
      processed: 4,
      done: true,
    });
    expect(await reprocessVerificationPage(db, { pageSize: 0 })).toMatchObject({ processed: 4 });
    expect(await reprocessVerificationPage(db, { pageSize: 100000 })).toMatchObject({
      processed: 4,
      done: true,
    });
  });

  test('treats an empty stored code as no code', async () => {
    const { db } = fakeDb([{ id: 'empty', content: 'nothing', verification_code: '' }]);

    expect(await reprocessVerificationPage(db)).toMatchObject({ processed: 1, changed: 0 });
  });

  test('counts a replaced code and reports at most twelve samples', async () => {
    const { db } = fakeDb([
      { id: 'replaced', content: 'Your OTP is 4821', verification_code: '9999' },
      ...Array.from({ length: 14 }, (_, index) => ({
        id: `stale-${index}`,
        content: 'nothing',
        verification_code: '1234',
      })),
    ]);

    const result = await reprocessVerificationPage(db, { dryRun: true });

    expect(result).toMatchObject({ changed: 15, replaced: 1, removed: 14, added: 0 });
    expect(result.samples).toHaveLength(12);
    expect(result.samples[0]).toEqual({ id: 'replaced', previous: '9999', next: '4821' });
  });

  test('fails when a scanned row does not match its schema', async () => {
    const statement: D1Statement<'all' | 'run'> = {
      bind: () => statement,
      all: () => Promise.resolve({ results: [{ row_cursor: 'x', id: 1 }] }),
      run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
    };
    const db: D1<'all' | 'run'> & D1Batch<'all' | 'run'> = {
      prepare: () => statement,
      batch: () => Promise.resolve([]),
    };

    let failure: unknown;
    try {
      await reprocessVerificationPage(db);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });
});
