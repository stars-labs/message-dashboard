import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch, D1Statement } from '../lib/d1.js';
import { countPending, sweepPending } from './spam-backfill.js';

interface Seed {
  id: string;
  type?: string | null;
  content: string;
  phone_number?: string | null;
  filter_status?: string;
  filter_rule_id?: number | null;
}

const Verdict = v.object({ filter_status: v.string(), filter_rule_id: v.nullable(v.number()) });

function database(messages: Seed[]) {
  const d1 = sqliteD1();
  d1.db.run(`CREATE TABLE filter_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('body_keyword', 'sender')),
    pattern TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  )`);
  d1.db.run(`INSERT INTO filter_rules (rule_type, pattern, is_active) VALUES
    ('sender', '10086', 1),
    ('body_keyword', '中国海关提示', 1),
    ('sender', '10010', 0)`);
  d1.db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    type TEXT,
    content TEXT NOT NULL,
    phone_number TEXT,
    filter_status TEXT NOT NULL DEFAULT 'pending',
    filter_rule_id INTEGER
  )`);
  const insert = d1.db.query(
    `INSERT INTO messages (id, type, content, phone_number, filter_status, filter_rule_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const message of messages) {
    insert.run(
      message.id,
      message.type === undefined ? 'received' : message.type,
      message.content,
      message.phone_number ?? null,
      message.filter_status ?? 'pending',
      message.filter_rule_id ?? null,
    );
  }
  const verdict = (id: string) =>
    v.parse(
      Verdict,
      d1.db.query('SELECT filter_status, filter_rule_id FROM messages WHERE id = ?').get(id),
    );
  return { d1, verdict };
}

let log: Mock<typeof console.log>;

beforeEach(() => {
  log = spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
});

describe('countPending', () => {
  test('counts the messages still waiting to be judged', async () => {
    const { d1 } = database([
      { id: 'a', content: 'x' },
      { id: 'b', content: 'x' },
      { id: 'c', content: 'x', filter_status: 'clean' },
    ]);

    expect(await countPending(d1)).toBe(2);
  });

  test('is zero for an empty table', async () => {
    expect(await countPending(database([]).d1)).toBe(0);
  });
});

describe('sweepPending', () => {
  test('judges pending messages with the active rules and records the matching rule', async () => {
    const { d1, verdict } = database([
      { id: 'spam-sender', content: 'promo', phone_number: '10086' },
      { id: 'spam-body', content: '中国海关提示，请勿携带', phone_number: '9528' },
      { id: 'clean', content: 'lunch?', phone_number: '+6590000000' },
      { id: 'inactive-rule', content: 'promo', phone_number: '10010' },
    ]);

    expect(await sweepPending(d1)).toEqual({ processed: 4, remaining: 0 });

    expect(verdict('spam-sender')).toEqual({ filter_status: 'filtered', filter_rule_id: 1 });
    expect(verdict('spam-body')).toEqual({ filter_status: 'filtered', filter_rule_id: 2 });
    expect(verdict('clean')).toEqual({ filter_status: 'clean', filter_rule_id: null });
    expect(verdict('inactive-rule')).toEqual({ filter_status: 'clean', filter_rule_id: null });
  });

  test('keeps a verification code and our own outbound messages clean', async () => {
    const { d1, verdict } = database([
      { id: 'otp', content: '验证码：754852，感谢您使用', phone_number: '10086' },
      { id: 'sent', type: 'sent', content: '中国海关提示', phone_number: '10086' },
      { id: 'untyped', type: null, content: 'promo', phone_number: '10086' },
    ]);

    await sweepPending(d1);

    expect(verdict('otp').filter_status).toBe('clean');
    expect(verdict('sent').filter_status).toBe('clean');
    expect(verdict('untyped').filter_status).toBe('filtered');
  });

  test('leaves judged messages alone and clears a stale rule on re-judged ones', async () => {
    const { d1, verdict } = database([
      { id: 'judged', content: 'promo', phone_number: '10086', filter_status: 'clean' },
      { id: 'rejudged', content: 'lunch?', phone_number: '9528', filter_rule_id: 9 },
    ]);

    expect(await sweepPending(d1)).toEqual({ processed: 1, remaining: 0 });

    expect(verdict('judged')).toEqual({ filter_status: 'clean', filter_rule_id: null });
    expect(verdict('rejudged')).toEqual({ filter_status: 'clean', filter_rule_id: null });
  });

  test('sweeps in pages of the requested size until the queue is drained', async () => {
    const { d1 } = database(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, content: 'x', phone_number: '10086' })),
    );

    expect(await sweepPending(d1, { pageSize: 2 })).toEqual({ processed: 5, remaining: 0 });
  });

  test('stops starting pages once the time budget is spent and reports what remains', async () => {
    const { d1 } = database([
      { id: 'a', content: 'x' },
      { id: 'b', content: 'x' },
    ]);

    expect(await sweepPending(d1, { budgetMs: 0 })).toEqual({ processed: 0, remaining: 2 });
  });

  test('logs how many it swept and how many are still pending', async () => {
    const { d1 } = database([{ id: 'a', content: 'x' }]);

    await sweepPending(d1);

    expect(log).toHaveBeenCalledWith('[spam-backfill] swept 1, 0 still pending');
  });

  test('fails when a pending row does not match its schema', async () => {
    const returning = (results: unknown[]): D1Statement => {
      const statement: D1Statement = {
        bind: () => statement,
        all: () => Promise.resolve({ results }),
        first: () => Promise.resolve({ n: 1 }),
        run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
      };
      return statement;
    };
    const db: D1 & D1Batch = {
      prepare: (sql) => returning(sql.includes('FROM messages') ? [{ id: 7, content: null }] : []),
      batch: () => Promise.resolve([]),
    };

    let failure: unknown;
    try {
      await sweepPending(db);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });
});
