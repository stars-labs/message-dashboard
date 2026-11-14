import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { setupKeywordRoutes } from './keywords.js';

type Router = Parameters<typeof setupKeywordRoutes>[0];
type Handler = Parameters<Router['get']>[1];
type KeywordRequest = Parameters<Handler>[0];
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
  setupKeywordRoutes(router);
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
    CREATE TABLE keyword_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      tag TEXT NOT NULL,
      color TEXT DEFAULT '#3B82F6',
      priority INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      case_sensitive BOOLEAN DEFAULT FALSE,
      whole_word BOOLEAN DEFAULT FALSE,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      type TEXT,
      content TEXT NOT NULL,
      verification_code TEXT,
      filter_status TEXT NOT NULL DEFAULT 'pending',
      purpose TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE message_tags (
      message_id TEXT NOT NULL,
      keyword_tag_id INTEGER NOT NULL,
      matched_text TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, keyword_tag_id, position),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
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

function addKeyword(
  { db }: TestDb,
  keyword: {
    keyword: string;
    tag?: string;
    color?: string | null;
    priority?: number;
    is_active?: number;
    case_sensitive?: number;
    whole_word?: number;
  },
) {
  db.query(
    `INSERT INTO keyword_tags (keyword, tag, color, priority, is_active, case_sensitive, whole_word)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    keyword.keyword,
    keyword.tag ?? 'OTP',
    keyword.color === undefined ? '#3B82F6' : keyword.color,
    keyword.priority ?? 0,
    keyword.is_active ?? 1,
    keyword.case_sensitive ?? 0,
    keyword.whole_word ?? 0,
  );
}

function addMessage(
  { db }: TestDb,
  message: { id: string; content?: string; created_at?: string; filter_status?: string },
) {
  db.query(
    `INSERT INTO messages (id, type, content, filter_status, created_at)
     VALUES (?, 'received', ?, ?, ?)`,
  ).run(
    message.id,
    message.content ?? 'hello',
    message.filter_status ?? 'clean',
    message.created_at ?? '2026-01-01 00:00:00',
  );
}

function addTag(
  { db }: TestDb,
  tag: { message_id: string; keyword_tag_id: number; position: number; matched_text?: string },
) {
  db.query(
    `INSERT INTO message_tags (message_id, keyword_tag_id, matched_text, position)
     VALUES (?, ?, ?, ?)`,
  ).run(tag.message_id, tag.keyword_tag_id, tag.matched_text ?? 'code', tag.position);
}

function request(
  { d1 }: TestDb,
  {
    path = '/api/keywords',
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
): KeywordRequest {
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

const Body = v.record(v.string(), v.unknown());

async function bodyOf(response: Response) {
  return v.parse(Body, await response.json());
}

const KEYWORD_COLUMNS = `id, keyword, tag, color, priority, is_active, case_sensitive, whole_word`;

function keywordRows({ db }: TestDb) {
  return db.query(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags ORDER BY id`).all();
}

describe('keyword rule D1 reads', () => {
  test('creating a keyword never scans or writes historical messages', async () => {
    const db = database();

    const response = await route(
      'post',
      '/api/keywords',
    )(
      request(db, {
        method: 'POST',
        body: JSON.stringify({
          keyword: 'code',
          tag: 'OTP',
          color: '#3B82F6',
          priority: 0,
          case_sensitive: false,
          whole_word: false,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(db.statements).toHaveLength(3);
    expect(db.statements.every((sql) => !/FROM messages|message_tags/i.test(sql))).toBe(true);
  });

  test('updates metadata only and rejects changes to matching identity', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });

    const handler = route('put', '/api/keywords/:id');
    const update = (body: unknown) =>
      handler(
        request(db, {
          method: 'PUT',
          path: '/api/keywords/1',
          body: JSON.stringify(body),
          params: { id: '1' },
        }),
      );

    const response = await update({ tag: 'Login' });
    expect(response.status).toBe(200);
    expect(db.statements).toHaveLength(2);
    expect(db.statements.every((sql) => !/messages|message_tags/i.test(sql))).toBe(true);

    db.statements.length = 0;
    const immutableResponse = await update({ whole_word: true });
    expect(immutableResponse.status).toBe(400);
    expect(db.statements).toHaveLength(1);
  });

  test('batch tag reads hide inactive keyword rules', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code', tag: 'Active' });
    addKeyword(db, { keyword: 'pin', tag: 'Inactive', is_active: 0 });
    addMessage(db, { id: 'm-1' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 1, position: 0 });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 2, position: 5 });

    const response = await route(
      'post',
      '/api/messages/batch-tags',
    )(
      request(db, {
        method: 'POST',
        path: '/api/messages/batch-tags',
        body: JSON.stringify({ messageIds: ['m-1'] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(db.statements.join('\n')).toContain('kt.is_active = TRUE');
    expect(await bodyOf(response)).toMatchObject({
      success: true,
      data: { 'm-1': [{ id: 1, tag: 'Active' }] },
    });
  });
});

describe('route registration', () => {
  test('registers every keyword route', () => {
    expect([...routes().keys()].sort()).toEqual([
      'delete /api/keywords/:id',
      'get /api/keywords',
      'get /api/keywords/:id',
      'get /api/messages/:id/tags',
      'post /api/keywords',
      'post /api/keywords/:id/history',
      'post /api/messages/batch-tags',
      'put /api/keywords/:id',
    ]);
  });
});

describe('authorization', () => {
  const guarded: { method: Method; path: string; httpMethod: string; viewerAllowed: boolean }[] = [
    { method: 'get', path: '/api/keywords', httpMethod: 'GET', viewerAllowed: false },
    { method: 'get', path: '/api/keywords/:id', httpMethod: 'GET', viewerAllowed: false },
    { method: 'post', path: '/api/keywords', httpMethod: 'POST', viewerAllowed: false },
    { method: 'put', path: '/api/keywords/:id', httpMethod: 'PUT', viewerAllowed: false },
    { method: 'delete', path: '/api/keywords/:id', httpMethod: 'DELETE', viewerAllowed: false },
    { method: 'post', path: '/api/keywords/:id/history', httpMethod: 'POST', viewerAllowed: false },
    { method: 'post', path: '/api/messages/batch-tags', httpMethod: 'POST', viewerAllowed: true },
    { method: 'get', path: '/api/messages/:id/tags', httpMethod: 'GET', viewerAllowed: true },
  ];

  for (const { method, path, httpMethod, viewerAllowed } of guarded) {
    test(`${method} ${path} answers 401 without a credential the middleware accepts`, async () => {
      const response = await route(
        method,
        path,
      )(
        request(database(), {
          method: httpMethod,
          credential: 'Bearer unknown',
          params: { id: '1' },
        }),
      );
      expect(response.status).toBe(401);
    });

    if (!viewerAllowed) {
      test(`${method} ${path} answers 403 to a role without the permission`, async () => {
        const response = await route(
          method,
          path,
        )(request(database(), { method: httpMethod, roles: ['viewer'], params: { id: '1' } }));
        expect(response.status).toBe(403);
      });
    }
  }

  test('a viewer may read message tags', async () => {
    const db = database();
    const response = await route(
      'get',
      '/api/messages/:id/tags',
    )(request(db, { roles: ['viewer'], params: { id: 'm-1' } }));
    expect(response.status).toBe(200);
  });

  test('a viewer may read batch tags', async () => {
    const db = database();
    const response = await route(
      'post',
      '/api/messages/batch-tags',
    )(request(db, { method: 'POST', roles: ['viewer'], body: '{"messageIds":["m-1"]}' }));
    expect(response.status).toBe(200);
  });
});

describe('GET /api/keywords', () => {
  test('lists every keyword with its usage count, highest priority first', async () => {
    const db = database();
    addKeyword(db, { keyword: 'beta', priority: 1 });
    addKeyword(db, { keyword: 'alpha', priority: 1 });
    addKeyword(db, { keyword: 'gamma', priority: 5 });
    addMessage(db, { id: 'm-1' });
    addMessage(db, { id: 'm-2' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 1, position: 0 });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 1, position: 9 });
    addTag(db, { message_id: 'm-2', keyword_tag_id: 1, position: 0 });

    const response = await route('get', '/api/keywords')(request(db));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      keywords: [
        { keyword: 'gamma', usage_count: 0 },
        { keyword: 'alpha', usage_count: 0 },
        { keyword: 'beta', usage_count: 2 },
      ],
    });
  });

  test('answers every column of the row', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code', tag: 'OTP', priority: 3, case_sensitive: 1 });

    const body = await bodyOf(await route('get', '/api/keywords')(request(db)));

    expect(body).toMatchObject({
      keywords: [
        {
          id: 1,
          keyword: 'code',
          tag: 'OTP',
          color: '#3B82F6',
          priority: 3,
          is_active: 1,
          case_sensitive: 1,
          whole_word: 0,
          created_by: null,
          usage_count: 0,
        },
      ],
    });
  });

  test('answers 500 when the read fails', async () => {
    const db = database();
    db.db.run('DROP TABLE message_tags');

    const response = await route('get', '/api/keywords')(request(db));

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to fetch keywords' });
  });
});

describe('GET /api/keywords/:id', () => {
  function fetchOne(db: TestDb, id: string) {
    return route(
      'get',
      '/api/keywords/:id',
    )(request(db, { path: `/api/keywords/${id}`, params: { id } }));
  }

  test('answers the keyword with its usage count', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });
    addMessage(db, { id: 'm-1' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 1, position: 0 });

    const response = await fetchOne(db, '1');

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      keyword: { id: 1, keyword: 'code', usage_count: 1 },
    });
  });

  test('answers 404 to a keyword that does not exist', async () => {
    const response = await fetchOne(database(), '9');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Keyword not found' });
  });

  test('answers 404 to an id that is not a number', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });

    expect((await fetchOne(db, 'abc')).status).toBe(404);
  });

  test('answers 500 when the read fails', async () => {
    const db = database();
    db.db.run('DROP TABLE keyword_tags');

    const response = await fetchOne(db, '1');

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to fetch keyword' });
  });
});

describe('POST /api/keywords', () => {
  function create(db: TestDb, body: string) {
    return route('post', '/api/keywords')(request(db, { method: 'POST', body }));
  }

  test('stores the keyword and answers the stored row', async () => {
    const db = database();

    const response = await create(
      db,
      JSON.stringify({
        keyword: 'code',
        tag: 'OTP',
        color: ' #aabbcc ',
        priority: 4,
        case_sensitive: true,
        whole_word: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({
      keyword: {
        id: 1,
        keyword: 'code',
        tag: 'OTP',
        color: '#aabbcc',
        priority: 4,
        is_active: 1,
        case_sensitive: 1,
        whole_word: 1,
        created_by: 'auth0|admin',
      },
    });
  });

  test('an omitted colour, priority and options take the defaults', async () => {
    const db = database();

    await create(db, JSON.stringify({ keyword: 'code', tag: 'OTP' }));

    expect(keywordRows(db)).toEqual([
      {
        id: 1,
        keyword: 'code',
        tag: 'OTP',
        color: '#3B82F6',
        priority: 0,
        is_active: 1,
        case_sensitive: 0,
        whole_word: 0,
      },
    ]);
  });

  test('a blank or null colour takes the default', async () => {
    const db = database();

    await create(db, JSON.stringify({ keyword: 'a1', tag: 'T', color: '' }));
    await create(db, JSON.stringify({ keyword: 'a2', tag: 'T', color: null }));

    expect(keywordRows(db)).toMatchObject([{ color: '#3B82F6' }, { color: '#3B82F6' }]);
  });

  test('a null priority is stored as 0', async () => {
    const db = database();

    await create(db, JSON.stringify({ keyword: 'a1', tag: 'T', priority: null }));

    expect(keywordRows(db)).toMatchObject([{ priority: 0 }]);
  });

  test('case_sensitive and whole_word are stored as given', async () => {
    const db = database();

    await create(
      db,
      JSON.stringify({ keyword: 'a1', tag: 'T', case_sensitive: true, whole_word: false }),
    );

    expect(keywordRows(db)).toMatchObject([{ case_sensitive: 1, whole_word: 0 }]);
  });

  const malformed: [string, unknown, string][] = [
    [
      'a priority that is a numeric string',
      { keyword: 'a1', tag: 'T', priority: '7' },
      'priority must be an integer',
    ],
    [
      'a priority that is not a number',
      { keyword: 'a1', tag: 'T', priority: 'x' },
      'priority must be an integer',
    ],
    [
      'a priority that is not whole',
      { keyword: 'a1', tag: 'T', priority: 1.5 },
      'priority must be an integer',
    ],
    [
      'a case_sensitive that is not a boolean',
      { keyword: 'a1', tag: 'T', case_sensitive: 'yes' },
      'case_sensitive must be true or false',
    ],
    [
      'a whole_word that is not a boolean',
      { keyword: 'a1', tag: 'T', whole_word: 1 },
      'whole_word must be true or false',
    ],
    ['a body that is null', null, 'Body must be a JSON object'],
    ['a body that is a number', 5, 'Body must be a JSON object'],
  ];

  for (const [name, body, message] of malformed) {
    test(`answers 400 to ${name} and writes nothing`, async () => {
      const db = database();

      const response = await create(db, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: message });
      expect(keywordRows(db)).toEqual([]);
    });
  }

  test('a keyword that only an inactive keyword uses can be created again', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code', is_active: 0 });

    const response = await create(db, JSON.stringify({ keyword: 'code', tag: 'OTP' }));

    expect(response.status).toBe(201);
  });

  const required: [string, unknown][] = [
    ['a missing keyword', { tag: 'OTP' }],
    ['an empty keyword', { keyword: '', tag: 'OTP' }],
    ['a keyword that is not text', { keyword: 5, tag: 'OTP' }],
    ['a missing tag', { keyword: 'code' }],
    ['an empty tag', { keyword: 'code', tag: '' }],
    ['a tag that is not text', { keyword: 'code', tag: 5 }],
  ];

  for (const [name, body] of required) {
    test(`answers 400 to ${name} and writes nothing`, async () => {
      const db = database();

      const response = await create(db, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: 'Keyword and tag are required' });
      expect(keywordRows(db)).toEqual([]);
    });
  }

  const badColors: [string, unknown, string][] = [
    [
      'a colour name',
      'red',
      'Invalid color: color must be a hex value such as #3B82F6 (3, 4, 6 or 8 hex digits)',
    ],
    [
      'a CSS payload',
      'red" onmouseover="x',
      'Invalid color: color must be a hex value such as #3B82F6 (3, 4, 6 or 8 hex digits)',
    ],
    ['a colour that is not text', 5, 'Invalid color: color must be a string'],
  ];

  for (const [name, color, message] of badColors) {
    test(`answers 400 to ${name} and writes nothing`, async () => {
      const db = database();

      const response = await create(db, JSON.stringify({ keyword: 'code', tag: 'OTP', color }));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: message });
      expect(keywordRows(db)).toEqual([]);
    });
  }

  test('answers 409 to a keyword that is already active', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });

    const response = await create(db, JSON.stringify({ keyword: 'code', tag: 'OTP' }));

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({ error: 'Keyword already exists' });
  });

  test('answers 400 when the body is not JSON', async () => {
    const db = database();

    const response = await create(db, 'not json');

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: 'Body must be JSON' });
    expect(keywordRows(db)).toEqual([]);
  });

  test('answers 500 with the details when the write fails', async () => {
    const db = database();
    db.db.run('DROP TABLE keyword_tags');

    const response = await create(db, JSON.stringify({ keyword: 'code', tag: 'OTP' }));
    const body = await bodyOf(response);

    expect(response.status).toBe(500);
    expect(body['error']).toBe('Failed to create keyword');
    expect(body['details']).toBe('no such table: keyword_tags');
  });
});

describe('PUT /api/keywords/:id', () => {
  function update(db: TestDb, body: string, id = '1') {
    return route(
      'put',
      '/api/keywords/:id',
    )(request(db, { method: 'PUT', path: `/api/keywords/${id}`, body, params: { id } }));
  }

  function seeded(overrides: Parameters<typeof addKeyword>[1] = { keyword: 'code' }) {
    const db = database();
    addKeyword(db, overrides);
    return db;
  }

  test('changes the tag, colour, priority and state, and answers the stored row', async () => {
    const db = seeded();

    const response = await update(
      db,
      JSON.stringify({ tag: 'Login', color: '#112233', priority: 9, is_active: false }),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      keyword: {
        id: 1,
        keyword: 'code',
        tag: 'Login',
        color: '#112233',
        priority: 9,
        is_active: 0,
      },
    });
  });

  test('answers 404 when the keyword is deleted before the update lands', async () => {
    const db = seeded();
    const racing: TestDb = {
      ...db,
      d1: {
        ...db.d1,
        prepare: (sql: string) => {
          if (sql.trimStart().startsWith('UPDATE')) db.db.run('DELETE FROM keyword_tags');
          return db.d1.prepare(sql);
        },
      },
    };

    const response = await update(racing, JSON.stringify({ tag: 'Login' }));

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toMatchObject({ error: 'Keyword not found' });
  });

  test('an empty tag keeps the stored one', async () => {
    const db = seeded();

    await update(db, JSON.stringify({ tag: '' }));

    expect(keywordRows(db)).toMatchObject([{ tag: 'OTP' }]);
  });

  test('omitted fields keep the stored values', async () => {
    const db = seeded({ keyword: 'code', priority: 4, is_active: 0, color: '#112233' });

    await update(db, JSON.stringify({ tag: 'Login' }));

    expect(keywordRows(db)).toMatchObject([
      { tag: 'Login', priority: 4, is_active: 0, color: '#112233' },
    ]);
  });

  test('is_active turns a keyword on', async () => {
    const db = seeded({ keyword: 'code', is_active: 0 });

    await update(db, JSON.stringify({ is_active: true }));

    expect(keywordRows(db)).toMatchObject([{ is_active: 1 }]);
  });

  test('a null priority is stored as 0', async () => {
    const db = seeded({ keyword: 'code', priority: 4 });

    await update(db, JSON.stringify({ priority: null }));

    expect(keywordRows(db)).toMatchObject([{ priority: 0 }]);
  });

  test('a null tag keeps the stored one', async () => {
    const db = seeded();

    await update(db, JSON.stringify({ tag: null }));

    expect(keywordRows(db)).toMatchObject([{ tag: 'OTP' }]);
  });

  const malformed: [string, unknown, string][] = [
    ['an is_active that is not a boolean', { is_active: 'yes' }, 'is_active must be true or false'],
    ['a priority that is a numeric string', { priority: '6' }, 'priority must be an integer'],
    ['a priority that is not whole', { priority: 1.5 }, 'priority must be an integer'],
    ['a tag that is not text', { tag: 5 }, 'tag must be a string'],
    [
      'a case_sensitive that is not a boolean',
      { case_sensitive: 1 },
      'case_sensitive must be true or false',
    ],
    ['a whole_word that is not a boolean', { whole_word: 0 }, 'whole_word must be true or false'],
    ['a keyword that is not text', { keyword: 5 }, 'keyword must be a string'],
    ['a body that is null', null, 'Body must be a JSON object'],
    ['a body that is a number', 5, 'Body must be a JSON object'],
  ];

  for (const [name, body, message] of malformed) {
    test(`answers 400 to ${name} and changes nothing`, async () => {
      const db = seeded({ keyword: 'code', priority: 4, is_active: 0 });

      const response = await update(db, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: message });
      expect(keywordRows(db)).toMatchObject([{ tag: 'OTP', priority: 4, is_active: 0 }]);
    });
  }

  test('an omitted, empty or null colour keeps the stored one', async () => {
    const db = seeded({ keyword: 'code', color: '#112233' });

    await update(db, JSON.stringify({ tag: 'A' }));
    await update(db, JSON.stringify({ color: '' }));
    await update(db, JSON.stringify({ color: null }));

    expect(keywordRows(db)).toMatchObject([{ color: '#112233' }]);
  });

  test('a stored colour that is not hex falls back to the default instead of failing', async () => {
    const db = seeded({ keyword: 'code', color: 'red" onmouseover="x' });

    const response = await update(db, JSON.stringify({ tag: 'A' }));

    expect(response.status).toBe(200);
    expect(keywordRows(db)).toMatchObject([{ color: '#3B82F6' }]);
  });

  test('a stored empty-string colour falls back to the default', async () => {
    const db = seeded({ keyword: 'code', color: '' });

    await update(db, JSON.stringify({ tag: 'A' }));

    expect(keywordRows(db)).toMatchObject([{ color: '#3B82F6' }]);
  });

  test('a null stored colour falls back to the default', async () => {
    const db = seeded({ keyword: 'code', color: null });

    await update(db, JSON.stringify({ tag: 'A' }));

    expect(keywordRows(db)).toMatchObject([{ color: '#3B82F6' }]);
  });

  const badColors: [string, unknown, string][] = [
    [
      'a colour that is not hex',
      'blue',
      'Invalid color: color must be a hex value such as #3B82F6 (3, 4, 6 or 8 hex digits)',
    ],
    ['a colour that is not text', 5, 'Invalid color: color must be a string'],
  ];

  for (const [name, color, message] of badColors) {
    test(`answers 400 to ${name} and changes nothing`, async () => {
      const db = seeded({ keyword: 'code', color: '#112233' });

      const response = await update(db, JSON.stringify({ color }));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: message });
      expect(keywordRows(db)).toMatchObject([{ color: '#112233' }]);
    });
  }

  test('accepts the stored keyword and options', async () => {
    const db = seeded({ keyword: 'code', case_sensitive: 1 });

    const response = await update(
      db,
      JSON.stringify({ keyword: 'code', case_sensitive: true, whole_word: false, tag: 'A' }),
    );

    expect(response.status).toBe(200);
  });

  const immutable: [string, unknown][] = [
    ['a different keyword', { keyword: 'other' }],
    ['a different case_sensitive', { case_sensitive: true }],
    ['a different whole_word', { whole_word: true }],
  ];

  for (const [name, body] of immutable) {
    test(`answers 400 to ${name}`, async () => {
      const db = seeded();

      const response = await update(db, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({
        error: 'Keyword and matching options are immutable; create a new keyword instead',
      });
    });
  }

  test('answers 404 to a keyword that does not exist, without reading the colour', async () => {
    const response = await update(database(), JSON.stringify({ color: 'blue' }), '9');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Keyword not found' });
  });

  test('answers 400 when the body is not JSON', async () => {
    const response = await update(seeded(), 'not json');

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: 'Body must be JSON' });
  });

  test('answers 404 to an unknown keyword before it reads the body', async () => {
    const response = await update(database(), 'not json', '9');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Keyword not found' });
  });

  test('answers 500 when the write fails', async () => {
    const db = seeded();
    db.db.run('DROP TABLE keyword_tags');

    const response = await update(db, JSON.stringify({ tag: 'A' }));

    expect(response.status).toBe(500);
  });
});

describe('DELETE /api/keywords/:id', () => {
  function remove(db: TestDb, id = '1') {
    return route(
      'delete',
      '/api/keywords/:id',
    )(request(db, { method: 'DELETE', path: `/api/keywords/${id}`, params: { id } }));
  }

  test('deletes an unreferenced keyword', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });

    const response = await remove(db);

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ success: true });
    expect(keywordRows(db)).toEqual([]);
  });

  test('answers 409 to a keyword that historical messages reference, and keeps it', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });
    addMessage(db, { id: 'm-1' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 1, position: 0 });

    const response = await remove(db);

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({
      error: 'Keyword has historical messages; deactivate it instead',
    });
    expect(keywordRows(db)).toHaveLength(1);
  });

  test('answers 404 to a keyword that does not exist', async () => {
    const response = await remove(database(), '9');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Keyword not found' });
  });

  test('answers 500 when the read fails', async () => {
    const db = database();
    db.db.run('DROP TABLE keyword_tags');

    const response = await remove(db);

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to delete keyword' });
  });
});

describe('POST /api/messages/batch-tags', () => {
  function batch(db: TestDb, body: string) {
    return route(
      'post',
      '/api/messages/batch-tags',
    )(request(db, { method: 'POST', path: '/api/messages/batch-tags', body }));
  }

  test('groups the active tags by message, in position order', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code', tag: 'OTP', priority: 2 });
    addKeyword(db, { keyword: 'pin', tag: 'PIN', color: null, priority: 1 });
    addMessage(db, { id: 'm-1' });
    addMessage(db, { id: 'm-2' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 2, position: 9, matched_text: 'pin' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 1, position: 0, matched_text: 'code' });
    addTag(db, { message_id: 'm-2', keyword_tag_id: 1, position: 3, matched_text: 'code' });

    const response = await batch(db, JSON.stringify({ messageIds: ['m-1', 'm-2'] }));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      success: true,
      data: {
        'm-1': [
          {
            id: 1,
            keyword: 'code',
            tag: 'OTP',
            color: '#3B82F6',
            priority: 2,
            position: 0,
            length: 4,
          },
          { id: 2, keyword: 'pin', tag: 'PIN', color: null, priority: 1, position: 9, length: 3 },
        ],
        'm-2': [
          {
            id: 1,
            keyword: 'code',
            tag: 'OTP',
            color: '#3B82F6',
            priority: 2,
            position: 3,
            length: 4,
          },
        ],
      },
    });
  });

  test('reads only the first 100 message ids', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });
    addMessage(db, { id: 'm-first' });
    addMessage(db, { id: 'm-late' });
    addTag(db, { message_id: 'm-first', keyword_tag_id: 1, position: 0 });
    addTag(db, { message_id: 'm-late', keyword_tag_id: 1, position: 0 });
    const ids = ['m-first', ...Array.from({ length: 98 }, (_, index) => `x-${index}`), 'm-fill'];
    expect(ids).toHaveLength(100);

    const response = await batch(db, JSON.stringify({ messageIds: [...ids, 'm-late'] }));

    const { data } = v.parse(
      v.object({ data: v.record(v.string(), v.array(v.unknown())) }),
      await response.json(),
    );
    expect(Object.keys(data)).toEqual(['m-first']);
  });

  test('answers an empty result to no ids without reading', async () => {
    const db = database();

    const response = await batch(db, JSON.stringify({ messageIds: [] }));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ success: true, data: {} });
    expect(db.statements).toEqual([]);
  });

  const malformed: [string, unknown, string][] = [
    ['ids that are not a list', { messageIds: 'm-1' }, 'messageIds must be an array of strings'],
    ['ids that are not text', { messageIds: [1] }, 'messageIds must be an array of strings'],
    ['a missing list', {}, 'messageIds must be an array of strings'],
    ['a body that is null', null, 'Body must be a JSON object'],
  ];

  for (const [name, body, message] of malformed) {
    test(`answers 400 to ${name} without reading`, async () => {
      const db = database();

      const response = await batch(db, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: message });
      expect(db.statements).toEqual([]);
    });
  }

  test('answers 500 when the read fails', async () => {
    const db = database();
    db.db.run('DROP TABLE message_tags');

    const response = await batch(db, JSON.stringify({ messageIds: ['m-1'] }));

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to fetch message tags' });
  });

  test('answers 400 when the body is not JSON', async () => {
    const db = database();

    const response = await batch(db, 'not json');

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: 'Body must be JSON' });
  });
});

describe('POST /api/keywords/:id/history', () => {
  const range = { since: '2026-01-01T00:00:00Z', until: '2026-12-31T00:00:00Z' };

  function history(db: TestDb, body: string, id = '1') {
    return route(
      'post',
      '/api/keywords/:id/history',
    )(
      request(db, {
        method: 'POST',
        path: `/api/keywords/${id}/history`,
        body,
        params: { id },
      }),
    );
  }

  function tagRows({ db }: TestDb) {
    return db
      .query(
        `SELECT message_id, keyword_tag_id, matched_text, position FROM message_tags ORDER BY 1, 4`,
      )
      .all();
  }

  test('tags the matching messages in range', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });
    addMessage(db, { id: 'm1', content: 'your code, code' });
    addMessage(db, { id: 'm2', content: 'nothing' });
    addMessage(db, { id: 'm3', content: 'code', created_at: '2027-01-01 00:00:00' });

    const response = await history(db, JSON.stringify(range));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      processed: 2,
      eligible: 2,
      matched_messages: 1,
      inserted: 2,
      has_more: false,
      next_cursor: null,
    });
    expect(tagRows(db)).toEqual([
      { message_id: 'm1', keyword_tag_id: 1, matched_text: 'code', position: 5 },
      { message_id: 'm1', keyword_tag_id: 1, matched_text: 'code', position: 11 },
    ]);
  });

  test('honours the stored case and whole-word options', async () => {
    const db = database();
    addKeyword(db, { keyword: 'Code', case_sensitive: 1, whole_word: 1 });
    addMessage(db, { id: 'm1', content: 'Code' });
    addMessage(db, { id: 'm2', content: 'code' });
    addMessage(db, { id: 'm3', content: 'Codes' });

    await history(db, JSON.stringify(range));

    expect(tagRows(db)).toEqual([
      { message_id: 'm1', keyword_tag_id: 1, matched_text: 'Code', position: 0 },
    ]);
  });

  test('answers the cursor of the next page', async () => {
    const db = database();
    addKeyword(db, { keyword: 'zzz' });
    for (let index = 0; index < 201; index++) {
      addMessage(db, {
        id: `m${String(index).padStart(3, '0')}`,
        created_at: '2026-01-02 00:00:00',
      });
    }

    const first = await bodyOf(await history(db, JSON.stringify(range)));
    expect(first).toMatchObject({ processed: 200, has_more: true });
    expect(first['next_cursor']).toEqual({ created_at: '2026-01-02 00:00:00', id: 'm199' });

    const second = await bodyOf(
      await history(db, JSON.stringify({ ...range, cursor: first['next_cursor'] })),
    );
    expect(second).toMatchObject({ processed: 1, has_more: false, next_cursor: null });
  });

  test('answers 404 to a keyword that does not exist', async () => {
    const response = await history(database(), JSON.stringify(range), '9');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'Keyword not found' });
  });

  test('answers 409 to an inactive keyword', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code', is_active: 0 });

    const response = await history(db, JSON.stringify(range));

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({
      error: 'Activate the keyword before applying it to history',
    });
  });

  const badRanges: [string, unknown][] = [
    ['a missing range', {}],
    ['a missing end', { since: range.since }],
    ['a range that is not dates', { since: 'yesterday', until: 'today' }],
    ['a range that is null', { since: null, until: null }],
    ['a range that is boolean', { since: true, until: false }],
    ['a range that is an array', { since: [2026], until: [2027] }],
    ['a range that ends before it starts', { since: range.until, until: range.since }],
  ];

  for (const [name, body] of badRanges) {
    test(`answers 400 to ${name}`, async () => {
      const db = database();
      addKeyword(db, { keyword: 'code' });

      const response = await history(db, JSON.stringify(body));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: 'A valid history time range is required' });
    });
  }

  const badCursors: [string, unknown][] = [
    ['a cursor with a created_at that is not a date', { created_at: 'x', id: 'a' }],
    ['a cursor without an id', { created_at: '2026-01-01 00:00:00' }],
    ['a cursor without a created_at', { id: 'a' }],
    ['a cursor that is not an object', 5],
    ['a cursor with an id that is not text', { created_at: '2026-01-01 00:00:00', id: 5 }],
  ];

  for (const [name, cursor] of badCursors) {
    test(`answers 400 to ${name}`, async () => {
      const db = database();
      addKeyword(db, { keyword: 'code' });

      const response = await history(db, JSON.stringify({ ...range, cursor }));

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toEqual({ error: 'Invalid history cursor' });
    });
  }

  test('answers 400 when the body is not JSON', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });

    const response = await history(db, 'not json');

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: 'Body must be JSON' });
  });

  test('answers 400 when the body is not an object', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });

    const response = await history(db, 'null');

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: 'Body must be a JSON object' });
  });

  test('accepts a null cursor as the first page', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code' });

    const response = await history(db, JSON.stringify({ ...range, cursor: null }));

    expect(response.status).toBe(200);
  });
});

describe('GET /api/messages/:id/tags', () => {
  function tagsOf(db: TestDb, id: string) {
    return route(
      'get',
      '/api/messages/:id/tags',
    )(request(db, { path: `/api/messages/${id}/tags`, params: { id } }));
  }

  test('answers the active tags of one message with the keyword fields, in position order', async () => {
    const db = database();
    addKeyword(db, { keyword: 'code', tag: 'OTP' });
    addKeyword(db, { keyword: 'pin', tag: 'PIN', is_active: 0 });
    addKeyword(db, { keyword: 'bank', tag: 'Bank', color: null });
    addMessage(db, { id: 'm-1' });
    addMessage(db, { id: 'm-2' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 3, position: 8, matched_text: 'bank' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 1, position: 1, matched_text: 'code' });
    addTag(db, { message_id: 'm-1', keyword_tag_id: 2, position: 4, matched_text: 'pin' });
    addTag(db, { message_id: 'm-2', keyword_tag_id: 1, position: 0, matched_text: 'code' });

    const response = await tagsOf(db, 'm-1');

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      tags: [
        {
          message_id: 'm-1',
          keyword_tag_id: 1,
          matched_text: 'code',
          position: 1,
          keyword: 'code',
          tag: 'OTP',
          color: '#3B82F6',
        },
        {
          message_id: 'm-1',
          keyword_tag_id: 3,
          matched_text: 'bank',
          position: 8,
          keyword: 'bank',
          tag: 'Bank',
          color: null,
        },
      ],
    });
  });

  test('answers an empty list for a message without tags', async () => {
    const response = await tagsOf(database(), 'm-1');

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ tags: [] });
  });

  test('answers 500 when the read fails', async () => {
    const db = database();
    db.db.run('DROP TABLE message_tags');

    const response = await tagsOf(db, 'm-1');

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to fetch message tags' });
  });
});
