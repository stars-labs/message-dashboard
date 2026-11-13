import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { listFilterRules, setupFilterRoutes } from './filters.js';

type Router = Parameters<typeof setupFilterRoutes>[0];
type Handler = Parameters<Router['get']>[1];
type FilterRequest = Parameters<Handler>[0];
type Method = 'get' | 'post' | 'put' | 'delete';

let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

function routes() {
  const registered = new Map<string, Handler>();
  const router: Router = {
    get: (path, handler) => registered.set(`get ${path}`, handler),
    post: (path, handler) => registered.set(`post ${path}`, handler),
    put: (path, handler) => registered.set(`put ${path}`, handler),
    delete: (path, handler) => registered.set(`delete ${path}`, handler),
  };
  setupFilterRoutes(router);
  return registered;
}

function route(method: Method, path: string): Handler {
  const handler = routes().get(`${method} ${path}`);
  if (!handler) throw new Error(`no ${method} ${path} route`);
  return handler;
}

function database() {
  const d1 = sqliteD1();
  d1.db.run(`
    CREATE TABLE filter_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type  TEXT NOT NULL CHECK(rule_type IN ('body_keyword', 'sender')),
      pattern    TEXT NOT NULL,
      note       TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(rule_type, pattern)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      type TEXT,
      content TEXT NOT NULL,
      phone_number TEXT,
      verification_code TEXT,
      filter_status TEXT NOT NULL DEFAULT 'pending',
      filter_rule_id INTEGER REFERENCES filter_rules(id) ON DELETE SET NULL,
      purpose TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const statements: string[] = [];
  const recorded = {
    ...d1,
    prepare: (sql: string) => {
      statements.push(sql);
      return d1.prepare(sql);
    },
  };
  return { d1: recorded, db: d1.db, statements };
}

type TestDb = ReturnType<typeof database>;

function addRule(
  { db }: TestDb,
  rule: { rule_type: string; pattern: string; note?: string | null; is_active?: number },
) {
  db.query(
    `INSERT INTO filter_rules (rule_type, pattern, note, is_active) VALUES (?, ?, ?, ?)`,
  ).run(rule.rule_type, rule.pattern, rule.note ?? null, rule.is_active ?? 1);
}

function addMessage(
  { db }: TestDb,
  message: {
    id: string;
    content: string;
    phone_number?: string;
    filter_status?: string;
    filter_rule_id?: number;
    created_at?: string;
  },
) {
  db.query(
    `INSERT INTO messages (id, type, content, phone_number, filter_status, filter_rule_id, created_at)
     VALUES (?, 'received', ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.content,
    message.phone_number ?? null,
    message.filter_status ?? 'pending',
    message.filter_rule_id ?? null,
    message.created_at ?? '2026-01-01 00:00:00',
  );
}

function request(
  { d1 }: TestDb,
  {
    path = '/api/filters',
    method = 'GET',
    body,
    params = {},
    roles = ['admin'],
    credential = 'Bearer session-1',
  }: {
    path?: string;
    method?: string;
    body?: string;
    params?: Record<string, string>;
    roles?: string[];
    credential?: string;
  } = {},
): FilterRequest {
  const sessions = new Map([
    [
      'session-1',
      JSON.stringify({ user: { id: 'auth0|admin', roles }, expires_at: Date.now() + 60_000 }),
    ],
  ]);
  const init: RequestInit = { method, headers: { Authorization: credential } };
  if (body !== undefined) init.body = body;
  return Object.assign(new Request(`https://example.com${path}`, init), {
    env: {
      DB: d1,
      SESSIONS: {
        get: (key: string) => Promise.resolve(sessions.get(key) ?? null),
        delete: () => Promise.resolve(),
      },
    },
    params,
  });
}

const RuleBody = v.object({
  id: v.number(),
  rule_type: v.string(),
  pattern: v.string(),
  note: v.nullable(v.string()),
  is_active: v.number(),
  created_by: v.nullable(v.string()),
});

const Body = v.looseObject({
  filters: v.optional(v.array(RuleBody)),
  filter: v.optional(v.nullable(RuleBody)),
  error: v.optional(v.string()),
  success: v.optional(v.boolean()),
  mode: v.optional(v.string()),
  processed: v.optional(v.number()),
  changed: v.optional(v.number()),
  has_more: v.optional(v.boolean()),
  next_cursor: v.optional(v.nullable(v.object({ created_at: v.string(), id: v.string() }))),
});

async function bodyOf(response: Response) {
  return v.parse(Body, await response.json());
}

function ruleRows({ db }: TestDb) {
  return db.query(`SELECT rule_type, pattern, note, is_active FROM filter_rules ORDER BY id`).all();
}

function messageRows({ db }: TestDb) {
  return db.query(`SELECT id, filter_status, filter_rule_id FROM messages ORDER BY id`).all();
}

describe('filter rule list D1 reads', () => {
  test('lists rule metadata without scanning messages for historical hit counts', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10655446', note: 'China Unicom marketing' });

    const result = await listFilterRules(db.d1);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toMatchObject({
      id: 1,
      rule_type: 'sender',
      pattern: '10655446',
      note: 'China Unicom marketing',
      is_active: 1,
    });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toContain('FROM filter_rules');
    expect(db.statements[0]).not.toMatch(/FROM messages|COUNT\s*\(/i);
    expect(db.statements.every((sql) => !sql.includes('filter_rule_id'))).toBe(true);
  });

  test('orders rules by type, then id', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });
    addRule(db, { rule_type: 'body_keyword', pattern: 'promo' });
    addRule(db, { rule_type: 'body_keyword', pattern: 'sale' });

    const result = await listFilterRules(db.d1);

    expect(result.filters.map((rule) => rule.pattern)).toEqual(['promo', 'sale', '10086']);
  });
});

describe('route registration', () => {
  test('registers every filter route', () => {
    expect([...routes().keys()].sort()).toEqual([
      'delete /api/filters/:id',
      'get /api/filters',
      'post /api/filters',
      'post /api/filters/:id/history',
      'put /api/filters/:id',
    ]);
  });
});

describe('authorization', () => {
  const guarded: { method: Method; path: string; httpMethod: string }[] = [
    { method: 'get', path: '/api/filters', httpMethod: 'GET' },
    { method: 'post', path: '/api/filters', httpMethod: 'POST' },
    { method: 'put', path: '/api/filters/:id', httpMethod: 'PUT' },
    { method: 'delete', path: '/api/filters/:id', httpMethod: 'DELETE' },
    { method: 'post', path: '/api/filters/:id/history', httpMethod: 'POST' },
  ];

  for (const { method, path, httpMethod } of guarded) {
    test(`${method} ${path} answers 401 without a credential the middleware accepts`, async () => {
      const db = database();
      const response = await route(
        method,
        path,
      )(request(db, { method: httpMethod, credential: 'Bearer unknown', params: { id: '1' } }));
      expect(response.status).toBe(401);
    });

    test(`${method} ${path} answers 403 to a role without the permission`, async () => {
      const db = database();
      const response = await route(
        method,
        path,
      )(request(db, { method: httpMethod, roles: ['viewer'], params: { id: '1' } }));
      expect(response.status).toBe(403);
    });
  }
});

describe('GET /api/filters', () => {
  test('answers the rules with every column', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086', note: 'mobile' });

    const response = await route('get', '/api/filters')(request(db));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.filters).toEqual([
      {
        id: 1,
        rule_type: 'sender',
        pattern: '10086',
        note: 'mobile',
        is_active: 1,
        created_by: null,
      },
    ]);
  });

  test('keeps the timestamps the table stores', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });

    const response = await route('get', '/api/filters')(request(db));
    const [rule] = v.parse(
      v.object({ filters: v.array(v.object({ created_at: v.string(), updated_at: v.string() })) }),
      await response.json(),
    ).filters;

    expect(rule?.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(rule?.updated_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  test('answers 500 when the read fails', async () => {
    const db = database();
    db.db.run('DROP TABLE filter_rules');

    const response = await route('get', '/api/filters')(request(db));

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to fetch filter rules' });
  });
});

describe('POST /api/filters', () => {
  function create(db: TestDb, body: string) {
    return route('post', '/api/filters')(request(db, { method: 'POST', body }));
  }

  test('creating a rule does not read or write historical messages', async () => {
    const db = database();

    const response = await create(db, JSON.stringify({ rule_type: 'sender', pattern: '10655446' }));

    expect(response.status).toBe(201);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toContain('INSERT INTO filter_rules');
    expect(db.statements[0]).not.toContain('messages');
    expect(await bodyOf(response)).toEqual({
      filter: {
        id: 1,
        rule_type: 'sender',
        pattern: '10655446',
        note: null,
        is_active: 1,
        created_by: 'auth0|admin',
      },
    });
  });

  test('stores the trimmed pattern and trimmed note of a body keyword', async () => {
    const db = database();

    const response = await create(
      db,
      JSON.stringify({ rule_type: 'body_keyword', pattern: '  promo  ', note: '  spam  ' }),
    );

    expect(response.status).toBe(201);
    expect(ruleRows(db)).toEqual([
      { rule_type: 'body_keyword', pattern: 'promo', note: 'spam', is_active: 1 },
    ]);
  });

  test('stores a numeric sender as bare digits', async () => {
    const db = database();

    await create(db, JSON.stringify({ rule_type: 'sender', pattern: '+86 100-86' }));

    expect(ruleRows(db)).toEqual([
      { rule_type: 'sender', pattern: '8610086', note: null, is_active: 1 },
    ]);
  });

  test('stores a named sender verbatim', async () => {
    const db = database();

    await create(db, JSON.stringify({ rule_type: 'sender', pattern: ' Telco ' }));

    expect(ruleRows(db)).toEqual([
      { rule_type: 'sender', pattern: 'Telco', note: null, is_active: 1 },
    ]);
  });

  test('a blank note is stored as null', async () => {
    const db = database();

    await create(db, JSON.stringify({ rule_type: 'sender', pattern: '10086', note: '   ' }));

    expect(ruleRows(db)).toEqual([
      { rule_type: 'sender', pattern: '10086', note: null, is_active: 1 },
    ]);
  });

  test('a note that is not text is stored as null', async () => {
    const db = database();

    const response = await create(
      db,
      JSON.stringify({ rule_type: 'sender', pattern: '10086', note: 42 }),
    );

    expect(response.status).toBe(201);
    expect(ruleRows(db)).toEqual([
      { rule_type: 'sender', pattern: '10086', note: null, is_active: 1 },
    ]);
  });

  const rejected: [string, unknown, string][] = [
    [
      'an unknown rule type',
      { rule_type: 'regex', pattern: 'abc' },
      'rule_type must be one of: body_keyword, sender',
    ],
    ['a missing rule type', { pattern: 'abc' }, 'rule_type must be one of: body_keyword, sender'],
    ['a missing pattern', { rule_type: 'sender' }, 'pattern is required'],
    ['a pattern that is not text', { rule_type: 'sender', pattern: 5 }, 'pattern is required'],
    ['a blank pattern', { rule_type: 'sender', pattern: '   ' }, 'pattern is required'],
    [
      'a one character keyword',
      { rule_type: 'body_keyword', pattern: 'a' },
      'body keyword must be at least 2 characters',
    ],
    [
      'a two character sender',
      { rule_type: 'sender', pattern: 'ab' },
      'sender pattern must be at least 3 characters',
    ],
    [
      'a numeric sender with too few digits',
      { rule_type: 'sender', pattern: '+--' },
      'sender pattern must contain at least 3 digits',
    ],
  ];

  for (const [name, body, message] of rejected) {
    test(`answers 400 to ${name} and writes nothing`, async () => {
      const db = database();

      const response = await create(db, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: message });
      expect(ruleRows(db)).toEqual([]);
    });
  }

  test('answers 409 to a rule that already exists', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });

    const response = await create(db, JSON.stringify({ rule_type: 'sender', pattern: '10086' }));

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({ error: 'That rule already exists' });
  });

  test('answers 500 when the body is not JSON', async () => {
    const db = database();

    const response = await create(db, 'not json');

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to create filter rule' });
  });

  test('answers 500 when the write fails', async () => {
    const db = database();
    db.db.run('DROP TABLE filter_rules');

    const response = await create(db, JSON.stringify({ rule_type: 'sender', pattern: '10086' }));

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to create filter rule' });
  });
});

describe('PUT /api/filters/:id', () => {
  function update(db: TestDb, id: string, body: string) {
    return route(
      'put',
      '/api/filters/:id',
    )(request(db, { method: 'PUT', path: `/api/filters/${id}`, body, params: { id } }));
  }

  test('toggling a rule changes only the rule row and keeps matching identity immutable', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10655446' });

    const response = await update(db, '1', JSON.stringify({ is_active: false }));

    expect(response.status).toBe(200);
    expect((await bodyOf(response)).filter).toMatchObject({ id: 1, is_active: 0 });
    expect(db.statements).toHaveLength(2);
    expect(db.statements.every((sql) => !sql.includes('messages'))).toBe(true);

    db.statements.length = 0;
    const immutableResponse = await update(db, '1', JSON.stringify({ pattern: '10086' }));
    expect(immutableResponse.status).toBe(400);
    expect(db.statements).toHaveLength(1);
  });

  test('is_active is true for any truthy value and false for any falsy one', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086', is_active: 0 });

    await update(db, '1', JSON.stringify({ is_active: 'yes' }));
    expect(ruleRows(db)).toMatchObject([{ is_active: 1 }]);

    await update(db, '1', JSON.stringify({ is_active: 0 }));
    expect(ruleRows(db)).toMatchObject([{ is_active: 0 }]);
  });

  test('an omitted is_active keeps the stored state', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086', is_active: 0 });

    await update(db, '1', JSON.stringify({ note: 'changed' }));

    expect(ruleRows(db)).toEqual([
      { rule_type: 'sender', pattern: '10086', note: 'changed', is_active: 0 },
    ]);
  });

  test('stores a trimmed note, and a blank note clears it', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086', note: 'old' });

    await update(db, '1', JSON.stringify({ note: '  new  ' }));
    expect(ruleRows(db)).toMatchObject([{ note: 'new' }]);

    await update(db, '1', JSON.stringify({ note: '  ' }));
    expect(ruleRows(db)).toMatchObject([{ note: null }]);
  });

  test('an omitted note keeps the stored one', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086', note: 'old' });

    await update(db, '1', JSON.stringify({ is_active: true }));

    expect(ruleRows(db)).toMatchObject([{ note: 'old' }]);
  });

  test('a note that is not text clears the stored one', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086', note: 'old' });

    const response = await update(db, '1', JSON.stringify({ note: 7 }));

    expect(response.status).toBe(200);
    expect(ruleRows(db)).toMatchObject([{ note: null }]);
  });

  test('accepts the stored rule type and pattern, even untrimmed', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });

    const response = await update(
      db,
      '1',
      JSON.stringify({ rule_type: 'sender', pattern: ' 10086 ', note: 'ok' }),
    );

    expect(response.status).toBe(200);
  });

  const immutable: [string, unknown][] = [
    ['a different rule type', { rule_type: 'body_keyword' }],
    ['a different pattern', { pattern: '10010' }],
    ['a pattern that is not text', { pattern: 10086 }],
  ];

  for (const [name, body] of immutable) {
    test(`answers 400 to ${name}`, async () => {
      const db = database();
      addRule(db, { rule_type: 'sender', pattern: '10086' });

      const response = await update(db, '1', JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({
        error: 'Rule type and pattern are immutable; create a new rule instead',
      });
    });
  }

  test('answers 404 to a rule that does not exist, without reading the body', async () => {
    const db = database();

    const response = await update(db, '9', 'not json');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Filter rule not found' });
  });

  test('answers 404 to an id that is not a number', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });

    const response = await update(db, 'abc', JSON.stringify({ note: 'x' }));

    expect(response.status).toBe(404);
  });

  test('answers 400 when the stored pattern no longer passes validation', async () => {
    const db = database();
    addRule(db, { rule_type: 'body_keyword', pattern: 'a' });

    const response = await update(db, '1', JSON.stringify({ note: 'x' }));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: 'body keyword must be at least 2 characters' });
  });

  test('answers 500 when the body is not JSON', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });

    const response = await update(db, '1', 'not json');

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to update filter rule' });
  });
});

describe('DELETE /api/filters/:id', () => {
  function remove(db: TestDb, id: string) {
    return route(
      'delete',
      '/api/filters/:id',
    )(request(db, { method: 'DELETE', path: `/api/filters/${id}`, params: { id } }));
  }

  test('deletes an unreferenced rule', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });

    const response = await remove(db, '1');

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ success: true });
    expect(ruleRows(db)).toEqual([]);
  });

  test('answers 409 to a rule that historical messages reference, and keeps it', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });
    addMessage(db, { id: 'm1', content: 'x', filter_status: 'filtered', filter_rule_id: 1 });

    const response = await remove(db, '1');

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({
      error: 'Rule has historical messages; deactivate it instead',
    });
    expect(ruleRows(db)).toHaveLength(1);
  });

  test('answers 404 to a rule that does not exist', async () => {
    const db = database();

    const response = await remove(db, '9');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Filter rule not found' });
  });

  test('answers 500 when the read fails', async () => {
    const db = database();
    db.db.run('DROP TABLE messages');

    const response = await remove(db, '1');

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to delete filter rule' });
  });
});

describe('POST /api/filters/:id/history', () => {
  const range = { since: '2026-01-01T00:00:00Z', until: '2026-12-31T00:00:00Z' };

  function history(db: TestDb, id: string, body: string) {
    return route(
      'post',
      '/api/filters/:id/history',
    )(
      request(db, {
        method: 'POST',
        path: `/api/filters/${id}/history`,
        body,
        params: { id },
      }),
    );
  }

  test('applies an active rule to the messages in range', async () => {
    const db = database();
    addRule(db, { rule_type: 'body_keyword', pattern: 'promo' });
    addMessage(db, { id: 'm1', content: 'big promo today' });
    addMessage(db, { id: 'm2', content: 'hello', created_at: '2026-01-02 00:00:00' });
    addMessage(db, { id: 'm3', content: 'promo', created_at: '2027-01-01 00:00:00' });

    const response = await history(db, '1', JSON.stringify(range));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      mode: 'apply',
      processed: 1,
      changed: 1,
      has_more: false,
      next_cursor: null,
    });
    expect(messageRows(db)).toEqual([
      { id: 'm1', filter_status: 'filtered', filter_rule_id: 1 },
      { id: 'm2', filter_status: 'pending', filter_rule_id: null },
      { id: 'm3', filter_status: 'pending', filter_rule_id: null },
    ]);
  });

  test('releases the messages of an inactive rule', async () => {
    const db = database();
    addRule(db, { rule_type: 'body_keyword', pattern: 'promo', is_active: 0 });
    addMessage(db, { id: 'm1', content: 'promo', filter_status: 'filtered', filter_rule_id: 1 });

    const response = await history(db, '1', JSON.stringify(range));

    expect((await bodyOf(response)).mode).toBe('release');
    expect(messageRows(db)).toEqual([{ id: 'm1', filter_status: 'clean', filter_rule_id: null }]);
  });

  test('answers the cursor of the next page', async () => {
    const db = database();
    addRule(db, { rule_type: 'body_keyword', pattern: 'hello' });
    for (let index = 0; index < 201; index++) {
      addMessage(db, {
        id: `m${String(index).padStart(3, '0')}`,
        content: 'hello',
        created_at: '2026-01-02 00:00:00',
      });
    }

    const first = await bodyOf(await history(db, '1', JSON.stringify(range)));
    expect(first).toMatchObject({ processed: 200, has_more: true });
    expect(first.next_cursor).toEqual({ created_at: '2026-01-02 00:00:00', id: 'm199' });

    const second = await bodyOf(
      await history(db, '1', JSON.stringify({ ...range, cursor: first.next_cursor })),
    );
    expect(second).toMatchObject({ processed: 1, has_more: false, next_cursor: null });
  });

  test('answers 404 to a rule that does not exist', async () => {
    const db = database();

    const response = await history(db, '9', JSON.stringify(range));

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Filter rule not found' });
  });

  const badRanges: [string, unknown][] = [
    ['a missing range', {}],
    ['a range that is not dates', { since: 'yesterday', until: 'today' }],
    ['a range that ends before it starts', { since: range.until, until: range.since }],
  ];

  for (const [name, body] of badRanges) {
    test(`answers 400 to ${name}`, async () => {
      const db = database();
      addRule(db, { rule_type: 'sender', pattern: '10086' });

      const response = await history(db, '1', JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: 'A valid history time range is required' });
    });
  }

  const badCursors: [string, unknown][] = [
    ['a cursor with a created_at that is not a date', { created_at: 'x', id: 'a' }],
    ['a cursor without an id', { created_at: '2026-01-01 00:00:00' }],
    ['a cursor that is not an object', { id: 'a' }],
  ];

  for (const [name, cursor] of badCursors) {
    test(`answers 400 to ${name}`, async () => {
      const db = database();
      addRule(db, { rule_type: 'sender', pattern: '10086' });

      const response = await history(db, '1', JSON.stringify({ ...range, cursor }));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: 'Invalid history cursor' });
    });
  }

  test('answers 500 when the body is not JSON', async () => {
    const db = database();
    addRule(db, { rule_type: 'sender', pattern: '10086' });

    const response = await history(db, '1', 'not json');

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to process filter history' });
  });
});
