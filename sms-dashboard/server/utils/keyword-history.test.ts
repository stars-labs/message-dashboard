import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch, D1Statement } from '../lib/d1.js';
import { processKeywordHistoryPage, type HistoryKeyword } from './keyword-history.js';

interface Seed {
  id: string;
  content?: string;
  type?: string | null;
  purpose?: string;
  filter_status?: string;
  verification_code?: string | null;
  created_at: string;
}

const Tag = v.object({
  message_id: v.string(),
  keyword_tag_id: v.number(),
  matched_text: v.string(),
  position: v.number(),
});

const keyword: HistoryKeyword = { id: 7, keyword: 'code', case_sensitive: 0, whole_word: 0 };
const window = { since: '2026-09-01T00:00:00.000Z', until: '2026-09-30T00:00:00.000Z' };

function database(messages: Seed[]) {
  const real = sqliteD1();
  real.db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    type TEXT,
    content TEXT NOT NULL,
    filter_status TEXT NOT NULL DEFAULT 'pending',
    verification_code TEXT,
    purpose TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMP
  )`);
  real.db.run(`CREATE TABLE message_tags (
    message_id TEXT NOT NULL,
    keyword_tag_id INTEGER NOT NULL,
    matched_text TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (message_id, keyword_tag_id, position)
  )`);
  const insert = real.db.query(
    `INSERT INTO messages (id, type, content, filter_status, verification_code, purpose, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const message of messages) {
    insert.run(
      message.id,
      message.type === undefined ? 'received' : message.type,
      message.content ?? 'Your code is 1234',
      message.filter_status ?? 'clean',
      message.verification_code ?? null,
      message.purpose ?? 'user',
      message.created_at,
    );
  }

  const reads: { sql: string; params: unknown[] }[] = [];
  const writes: { sql: string; params: unknown[] }[][] = [];
  const known = new WeakMap<D1Statement, { sql: string; params: unknown[] }>();
  function wrap(sql: string, statement: D1Statement, params: unknown[]): D1Statement {
    const wrapped: D1Statement = {
      bind: (...values) => wrap(sql, statement.bind(...values), values),
      all: () => {
        reads.push({ sql, params });
        return statement.all();
      },
      first: () => statement.first(),
      run: () => statement.run(),
    };
    known.set(wrapped, { sql, params });
    return wrapped;
  }
  const db: D1 & D1Batch = {
    prepare: (sql) => wrap(sql, real.prepare(sql), []),
    batch: (statements) => {
      writes.push(statements.flatMap((statement) => known.get(statement) ?? []));
      return real.batch(statements);
    },
  };

  const tags = () =>
    v.parse(
      v.array(Tag),
      real.db
        .query(
          'SELECT message_id, keyword_tag_id, matched_text, position FROM message_tags ORDER BY message_id, position',
        )
        .all(),
    );
  return { db, reads, writes, tags };
}

describe('bounded keyword history processing', () => {
  test('reads one indexed page, skips ineligible messages, and inserts matches idempotently', async () => {
    const { db, reads, writes, tags } = database([
      { id: 'm-1', content: 'Your code is 1234', created_at: '2026-09-01 00:00:00' },
      {
        id: 'm-2',
        content: 'code in filtered mail',
        filter_status: 'filtered',
        created_at: '2026-09-02 00:00:00',
      },
      { id: 'm-3', content: 'lookahead row', created_at: '2026-09-03 00:00:00' },
    ]);

    const result = await processKeywordHistoryPage(db, keyword, {
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-04T00:00:00.000Z',
      pageSize: 2,
    });

    const pageRead = reads.find(({ sql }) => sql.includes('FROM messages'));
    expect(pageRead?.sql).toContain("purpose = 'user'");
    expect(pageRead?.sql).toContain('ORDER BY created_at, id');
    expect(pageRead?.sql).not.toMatch(
      /instr\s*\(|LIKE|verification_code IS NULL|filter_status\s*[=<>]/i,
    );
    expect(pageRead?.params.at(-1)).toBe(3);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(1);
    expect(writes[0]?.[0]?.sql).toContain('INSERT OR IGNORE INTO message_tags');
    expect(writes[0]?.[0]?.params).toEqual(['m-1', 7, 'code', 5]);
    expect(result).toEqual({
      processed: 2,
      eligible: 1,
      matched_messages: 1,
      inserted: 1,
      has_more: true,
      next_cursor: { created_at: '2026-09-02 00:00:00', id: 'm-2' },
    });
    expect(tags()).toEqual([
      { message_id: 'm-1', keyword_tag_id: 7, matched_text: 'code', position: 5 },
    ]);
  });

  test('uses the stable cursor and propagates D1 failures', async () => {
    const statement: D1Statement<'all' | 'run'> & { params: unknown[] } = {
      params: [],
      bind: (...params) => ({ ...statement, params }),
      all: () => Promise.reject(new Error('D1 unavailable')),
      run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
    };
    const seen: unknown[][] = [];
    const db: D1<'all' | 'run'> & D1Batch<'all' | 'run'> = {
      prepare: (sql) => {
        expect(sql).toContain('(created_at > ? OR (created_at = ? AND id > ?))');
        return {
          ...statement,
          bind: (...params) => {
            seen.push(params);
            return statement;
          },
        };
      },
      batch: () => Promise.resolve([]),
    };

    let failure: unknown;
    try {
      await processKeywordHistoryPage(db, keyword, {
        ...window,
        cursor: { created_at: '2026-09-02 00:00:00', id: 'm-2' },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(new Error('D1 unavailable'));
    expect(seen[0]?.slice(2, 5)).toEqual(['2026-09-02 00:00:00', '2026-09-02 00:00:00', 'm-2']);
  });

  test('continues strictly after the cursor until the window is drained', async () => {
    const { db, tags } = database([
      { id: 'a', created_at: '2026-09-01 00:00:00' },
      { id: 'b', created_at: '2026-09-01 00:00:00' },
      { id: 'c', created_at: '2026-09-02 00:00:00' },
    ]);

    const first = await processKeywordHistoryPage(db, keyword, { ...window, pageSize: 2 });
    expect(first).toMatchObject({ processed: 2, inserted: 2, has_more: true });
    expect(first.next_cursor).toEqual({ created_at: '2026-09-01 00:00:00', id: 'b' });

    const second = await processKeywordHistoryPage(db, keyword, {
      ...window,
      cursor: first.next_cursor,
      pageSize: 2,
    });
    expect(second).toEqual({
      processed: 1,
      eligible: 1,
      matched_messages: 1,
      inserted: 1,
      has_more: false,
      next_cursor: null,
    });
    expect(tags().map((tag) => tag.message_id)).toEqual(['a', 'b', 'c']);
  });

  test('inserts nothing new when the same page is applied again', async () => {
    const { db, tags } = database([{ id: 'a', created_at: '2026-09-01 00:00:00' }]);

    expect(await processKeywordHistoryPage(db, keyword, window)).toMatchObject({ inserted: 1 });
    expect(await processKeywordHistoryPage(db, keyword, window)).toMatchObject({
      eligible: 1,
      matched_messages: 1,
      inserted: 0,
    });
    expect(tags()).toHaveLength(1);
  });

  test('records every occurrence of the keyword in a message', async () => {
    const { db, tags } = database([
      { id: 'a', content: 'code, then CODE, then code', created_at: '2026-09-01 00:00:00' },
    ]);

    const result = await processKeywordHistoryPage(db, keyword, window);

    expect(result).toMatchObject({ eligible: 1, matched_messages: 1, inserted: 3 });
    expect(tags().map((tag) => [tag.matched_text, tag.position])).toEqual([
      ['code', 0],
      ['CODE', 11],
      ['code', 22],
    ]);
  });

  test('honours the case-sensitive and whole-word flags, as numbers or booleans', async () => {
    const matched = async (content: string, flags: Partial<HistoryKeyword>) =>
      (
        await processKeywordHistoryPage(
          database([{ id: 'a', content, created_at: '2026-09-01 00:00:00' }]).db,
          { ...keyword, ...flags },
          window,
        )
      ).matched_messages;

    expect(await matched('Code', {})).toBe(1);
    expect(await matched('Code', { case_sensitive: 1 })).toBe(0);
    expect(await matched('Code', { case_sensitive: true })).toBe(0);
    expect(await matched('code', { case_sensitive: 1 })).toBe(1);
    expect(await matched('encoded', {})).toBe(1);
    expect(await matched('encoded', { whole_word: 1 })).toBe(0);
    expect(await matched('encoded', { whole_word: true })).toBe(0);
    expect(await matched('a code.', { whole_word: 1 })).toBe(1);
  });

  test('skips messages the keyword is not applied to', async () => {
    const { db, tags } = database([
      { id: 'sent', type: 'sent', created_at: '2026-09-01 00:00:00' },
      { id: 'untyped', type: null, created_at: '2026-09-01 00:00:01' },
      { id: 'code', verification_code: '1234', created_at: '2026-09-01 00:00:02' },
      { id: 'filtered', filter_status: 'filtered', created_at: '2026-09-01 00:00:03' },
      { id: 'internal', purpose: 'balance_maintenance', created_at: '2026-09-01 00:00:04' },
      { id: 'before', created_at: '2026-08-31 23:59:59' },
      { id: 'after', created_at: '2026-10-01 00:00:00' },
      { id: 'pending', filter_status: 'pending', created_at: '2026-09-01 00:00:05' },
    ]);

    const result = await processKeywordHistoryPage(db, keyword, window);

    expect(result).toMatchObject({ processed: 5, eligible: 1, matched_messages: 1, inserted: 1 });
    expect(tags().map((tag) => tag.message_id)).toEqual(['pending']);
  });

  test('counts an eligible message without a match as eligible only', async () => {
    const { db } = database([
      { id: 'a', content: 'nothing here', created_at: '2026-09-01 00:00:00' },
    ]);

    expect(await processKeywordHistoryPage(db, keyword, window)).toEqual({
      processed: 1,
      eligible: 1,
      matched_messages: 0,
      inserted: 0,
      has_more: false,
      next_cursor: null,
    });
  });

  test('answers an empty window without writing', async () => {
    const { db, writes } = database([]);

    expect(await processKeywordHistoryPage(db, keyword, window)).toEqual({
      processed: 0,
      eligible: 0,
      matched_messages: 0,
      inserted: 0,
      has_more: false,
      next_cursor: null,
    });
    expect(writes).toEqual([]);
  });

  test('bounds the page size to between 1 and 200 and defaults a bad one', async () => {
    const { db, reads } = database([]);
    const limitFor = async (pageSize: unknown) => {
      reads.length = 0;
      await processKeywordHistoryPage(db, keyword, { ...window, pageSize });
      return reads[0]?.params.at(-1);
    };

    expect(await limitFor(undefined)).toBe(201);
    expect(await limitFor(5)).toBe(6);
    expect(await limitFor('7')).toBe(8);
    expect(await limitFor(100000)).toBe(201);
    expect(await limitFor(0)).toBe(201);
    expect(await limitFor('many')).toBe(201);
    expect(await limitFor(-3)).toBe(2);
  });

  test('fails when a scanned row does not match its schema', async () => {
    const statement: D1Statement<'all' | 'run'> = {
      bind: () => statement,
      all: () => Promise.resolve({ results: [{ id: 1, content: null }] }),
      run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
    };
    const db: D1<'all' | 'run'> & D1Batch<'all' | 'run'> = {
      prepare: () => statement,
      batch: () => Promise.resolve([]),
    };

    let failure: unknown;
    try {
      await processKeywordHistoryPage(db, keyword, window);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });
});
