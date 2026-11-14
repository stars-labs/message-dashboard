import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch, D1Statement } from '../lib/d1.js';
import { processRuleHistoryPage, type HistoryRule } from './filter-history.js';

interface Seed {
  id: string;
  phone_number?: string | null;
  content?: string;
  type?: string;
  purpose?: string;
  filter_status?: string;
  filter_rule_id?: number | null;
  verification_code?: string | null;
  created_at: string;
}

const Verdict = v.object({ filter_status: v.string(), filter_rule_id: v.nullable(v.number()) });

const senderRule: HistoryRule = {
  id: 9,
  rule_type: 'sender',
  pattern: '10655446',
  is_active: 1,
};

const window = { since: '2026-09-01T00:00:00.000Z', until: '2026-09-30T00:00:00.000Z' };

function database(messages: Seed[], { ruleActive = true }: { ruleActive?: boolean } = {}) {
  const real = sqliteD1();
  real.db.run(`CREATE TABLE filter_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('body_keyword', 'sender')),
    pattern TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  )`);
  real.db
    .query(
      `INSERT INTO filter_rules (id, rule_type, pattern, is_active) VALUES (9, 'sender', '10655446', ?)`,
    )
    .run(ruleActive ? 1 : 0);
  real.db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    type TEXT,
    content TEXT NOT NULL,
    phone_number TEXT,
    filter_status TEXT NOT NULL DEFAULT 'pending',
    filter_rule_id INTEGER,
    purpose TEXT NOT NULL DEFAULT 'user',
    verification_code TEXT,
    created_at TIMESTAMP
  )`);
  const insert = real.db.query(
    `INSERT INTO messages (id, type, content, phone_number, filter_status, filter_rule_id,
       purpose, verification_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const message of messages) {
    insert.run(
      message.id,
      message.type ?? 'received',
      message.content ?? 'ordinary marketing',
      message.phone_number === undefined ? '106554460' : message.phone_number,
      message.filter_status ?? 'clean',
      message.filter_rule_id ?? null,
      message.purpose ?? 'user',
      message.verification_code ?? null,
      message.created_at,
    );
  }

  const queries: { sql: string; params: unknown[] }[] = [];
  const batches: number[] = [];
  function wrap(sql: string, statement: D1Statement, params: unknown[]): D1Statement {
    return {
      bind: (...values) => wrap(sql, statement.bind(...values), values),
      all: () => {
        queries.push({ sql, params });
        return statement.all();
      },
      first: () => statement.first(),
      run: () => statement.run(),
    };
  }
  const db: D1 & D1Batch = {
    prepare: (sql) => wrap(sql, real.prepare(sql), []),
    batch: (statements) => {
      batches.push(statements.length);
      return real.batch(statements);
    },
  };

  const verdict = (id: string) =>
    v.parse(
      Verdict,
      real.db.query('SELECT filter_status, filter_rule_id FROM messages WHERE id = ?').get(id),
    );
  return { db, queries, batches, verdict };
}

describe('bounded filter history processing', () => {
  test('writes only changed final verdicts and returns a stable page cursor', async () => {
    const { db, queries, batches, verdict } = database([
      { id: 'm-1', phone_number: '106554460', created_at: '2026-09-01 00:00:00' },
      { id: 'm-2', phone_number: '13106554461', created_at: '2026-09-02 00:00:00' },
      { id: 'm-3', phone_number: '106554462', created_at: '2026-09-03 00:00:00' },
    ]);

    const result = await processRuleHistoryPage(db, senderRule, {
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-04T00:00:00.000Z',
      pageSize: 2,
    });

    const candidateQuery = queries.find(({ sql }) => sql.includes('FROM messages'));
    expect(candidateQuery?.sql).toContain('verification_code IS NULL');
    expect(candidateQuery?.sql).toContain("filter_status <> 'filtered'");
    expect(candidateQuery?.sql).toContain('created_at >= datetime(?)');
    expect(candidateQuery?.params.at(-1)).toBe(3);
    expect(queries.some(({ sql }) => /SET filter_status = ['"]pending/i.test(sql))).toBe(false);
    expect(batches).toEqual([1]);
    expect(result).toEqual({
      mode: 'apply',
      processed: 2,
      changed: 1,
      has_more: true,
      next_cursor: { created_at: '2026-09-02 00:00:00', id: 'm-2' },
    });
    expect(verdict('m-1')).toEqual({ filter_status: 'filtered', filter_rule_id: 9 });
    expect(verdict('m-2')).toEqual({ filter_status: 'clean', filter_rule_id: null });
    expect(verdict('m-3')).toEqual({ filter_status: 'clean', filter_rule_id: null });
  });

  test('continues strictly after the cursor and ends without one', async () => {
    const { db, verdict } = database([
      { id: 'a', created_at: '2026-09-01 00:00:00' },
      { id: 'b', created_at: '2026-09-01 00:00:00' },
      { id: 'c', created_at: '2026-09-02 00:00:00' },
    ]);

    const first = await processRuleHistoryPage(db, senderRule, { ...window, pageSize: 2 });
    expect(first).toMatchObject({ processed: 2, changed: 2, has_more: true });
    expect(first.next_cursor).toEqual({ created_at: '2026-09-01 00:00:00', id: 'b' });

    const second = await processRuleHistoryPage(db, senderRule, {
      ...window,
      cursor: first.next_cursor,
      pageSize: 2,
    });
    expect(second).toEqual({
      mode: 'apply',
      processed: 1,
      changed: 1,
      has_more: false,
      next_cursor: null,
    });
    expect(verdict('c').filter_status).toBe('filtered');
  });

  test('applies a body-keyword rule', async () => {
    const { db, verdict } = database([
      {
        id: 'hit',
        content: '中国海关提示，请勿携带',
        phone_number: '9528',
        created_at: '2026-09-01 00:00:00',
      },
      { id: 'miss', content: 'lunch?', phone_number: '9528', created_at: '2026-09-02 00:00:00' },
    ]);
    const rule: HistoryRule = {
      id: 3,
      rule_type: 'body_keyword',
      pattern: '中国海关提示',
      is_active: 1,
    };

    expect(await processRuleHistoryPage(db, rule, window)).toMatchObject({
      mode: 'apply',
      processed: 1,
    });
    expect(verdict('hit').filter_status).toBe('clean');
  });

  test('skips messages the rule must not touch', async () => {
    const { db, verdict } = database([
      { id: 'sent', type: 'sent', created_at: '2026-09-01 00:00:00' },
      { id: 'internal', purpose: 'balance_maintenance', created_at: '2026-09-01 00:00:01' },
      { id: 'code', verification_code: '123456', created_at: '2026-09-01 00:00:02' },
      {
        id: 'already',
        filter_status: 'filtered',
        filter_rule_id: 4,
        created_at: '2026-09-01 00:00:03',
      },
      { id: 'before', created_at: '2026-08-31 23:59:59' },
      { id: 'after', created_at: '2026-10-01 00:00:00' },
      { id: 'other-number', phone_number: '9528', created_at: '2026-09-01 00:00:04' },
      { id: 'no-number', phone_number: null, created_at: '2026-09-01 00:00:05' },
      { id: 'hit', created_at: '2026-09-01 00:00:06' },
    ]);

    const result = await processRuleHistoryPage(db, senderRule, window);

    expect(result).toMatchObject({ processed: 1, changed: 1 });
    expect(verdict('hit').filter_status).toBe('filtered');
    for (const id of ['sent', 'internal', 'code', 'before', 'after', 'other-number', 'no-number']) {
      expect(verdict(id).filter_status).toBe('clean');
    }
    expect(verdict('already')).toEqual({ filter_status: 'filtered', filter_rule_id: 4 });
  });

  test('releases the messages a deactivated rule hid', async () => {
    const { db, queries, verdict } = database(
      [
        {
          id: 'mine',
          filter_status: 'filtered',
          filter_rule_id: 9,
          created_at: '2026-09-01 00:00:00',
        },
        {
          id: 'theirs',
          filter_status: 'filtered',
          filter_rule_id: 4,
          created_at: '2026-09-01 00:00:01',
        },
        { id: 'plain', created_at: '2026-09-01 00:00:02' },
      ],
      { ruleActive: false },
    );

    const result = await processRuleHistoryPage(db, { ...senderRule, is_active: 0 }, window);

    expect(result).toEqual({
      mode: 'release',
      processed: 1,
      changed: 1,
      has_more: false,
      next_cursor: null,
    });
    expect(verdict('mine')).toEqual({ filter_status: 'clean', filter_rule_id: null });
    expect(verdict('theirs')).toEqual({ filter_status: 'filtered', filter_rule_id: 4 });
    expect(queries.find(({ sql }) => sql.includes('FROM messages'))?.sql).toContain(
      'filter_rule_id = ?',
    );
  });

  test('reads a boolean is_active as the mode', async () => {
    const { db } = database([{ id: 'a', created_at: '2026-09-01 00:00:00' }]);

    expect(
      (await processRuleHistoryPage(db, { ...senderRule, is_active: true }, window)).mode,
    ).toBe('apply');
    expect(
      (await processRuleHistoryPage(db, { ...senderRule, is_active: false }, window)).mode,
    ).toBe('release');
  });

  test('answers an empty window without loading rules or writing', async () => {
    const { db, queries, batches } = database([]);

    expect(await processRuleHistoryPage(db, senderRule, window)).toEqual({
      mode: 'apply',
      processed: 0,
      changed: 0,
      has_more: false,
      next_cursor: null,
    });
    expect(queries.some(({ sql }) => sql.includes('FROM filter_rules'))).toBe(false);
    expect(batches).toEqual([]);
  });

  test('does not write a page whose verdicts are all unchanged', async () => {
    const { db, batches } = database([
      { id: 'a', phone_number: '9528', created_at: '2026-09-01 00:00:00', filter_status: 'clean' },
    ]);
    const rule: HistoryRule = {
      id: 3,
      rule_type: 'body_keyword',
      pattern: 'marketing',
      is_active: 1,
    };

    expect(await processRuleHistoryPage(db, rule, window)).toMatchObject({
      processed: 1,
      changed: 0,
    });
    expect(batches).toEqual([]);
  });

  test('bounds the page size to between 1 and 200 and defaults a bad one', async () => {
    const { db, queries } = database([]);
    const limitFor = async (pageSize: unknown) => {
      queries.length = 0;
      await processRuleHistoryPage(db, senderRule, { ...window, pageSize });
      return queries.find(({ sql }) => sql.includes('FROM messages'))?.params.at(-1);
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
    const returning = (results: unknown[]): D1Statement<'all' | 'run'> => {
      const statement: D1Statement<'all' | 'run'> = {
        bind: () => statement,
        all: () => Promise.resolve({ results }),
        run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
      };
      return statement;
    };
    const db: D1<'all' | 'run'> & D1Batch<'all' | 'run'> = {
      prepare: (sql) =>
        returning(sql.includes('FROM messages') ? [{ id: 1, created_at: null }] : []),
      batch: () => Promise.resolve([]),
    };

    let failure: unknown;
    try {
      await processRuleHistoryPage(db, senderRule, window);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });
});
