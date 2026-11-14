import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { setupVerificationRoutes } from './verification.js';

type Router = Parameters<typeof setupVerificationRoutes>[0];
type Handler = Parameters<Router['post']>[1];
type Request = Parameters<Handler>[0];

let logSpy: Mock<typeof console.log>;
let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  logSpy = spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function registeredHandler(): { path: string; handler: Handler } {
  let registered: { path: string; handler: Handler } | undefined;
  setupVerificationRoutes({
    post: (path, handler) => {
      registered = { path, handler };
    },
  });
  if (!registered) throw new Error('no route registered');
  return registered;
}

function database(messages: { id: string; content: string; verification_code?: string }[]) {
  const d1 = sqliteD1();
  d1.db.run(`CREATE TABLE filter_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL,
    pattern TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  )`);
  d1.db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    type TEXT,
    content TEXT NOT NULL,
    phone_number TEXT,
    verification_code TEXT,
    filter_status TEXT NOT NULL DEFAULT 'clean',
    filter_rule_id INTEGER,
    updated_at TIMESTAMP
  )`);
  for (const message of messages) {
    d1.db
      .query(
        `INSERT INTO messages (id, type, content, verification_code) VALUES (?, 'received', ?, ?)`,
      )
      .run(message.id, message.content, message.verification_code ?? null);
  }
  return d1;
}

function request(
  db: ReturnType<typeof database>,
  { query = '', credential = 'Bearer session-1', roles = ['admin'] } = {},
): Request {
  const sessions = new Map([
    [
      'session-1',
      JSON.stringify({ user: { id: 'auth0|u', roles }, expires_at: Date.now() + 60_000 }),
    ],
  ]);
  return {
    url: `https://example.com/api/verification/reprocess${query}`,
    headers: new Headers({ Authorization: credential }),
    env: {
      DB: db,
      SESSIONS: {
        get: (key) => Promise.resolve(sessions.get(key) ?? null),
        delete: () => Promise.resolve(),
      },
    },
  };
}

const Body = v.looseObject({
  success: v.optional(v.boolean()),
  error: v.optional(v.string()),
  processed: v.optional(v.number()),
  changed: v.optional(v.number()),
  dry_run: v.optional(v.boolean()),
  filter_sweep: v.optional(v.nullable(v.looseObject({ processed: v.number() }))),
});

async function bodyOf(response: Response) {
  return v.parse(Body, await response.json());
}

describe('POST /api/verification/reprocess', () => {
  test('registers the reprocess route', () => {
    expect(registeredHandler().path).toBe('/api/verification/reprocess');
  });

  test('answers 401 without a credential the middleware accepts', async () => {
    const { handler } = registeredHandler();
    const response = await handler(request(database([]), { credential: 'Bearer unknown' }));
    expect(response.status).toBe(401);
  });

  test('answers 403 to a role without filters.write', async () => {
    const { handler } = registeredHandler();
    const response = await handler(request(database([]), { roles: ['viewer'] }));
    expect(response.status).toBe(403);
  });

  test('a dry run reports the changes and writes nothing', async () => {
    const { handler } = registeredHandler();
    const db = database([
      { id: 'm1', content: 'Your code is 123456', verification_code: '000000' },
    ]);

    const response = await handler(request(db, { query: '?dry_run=1' }));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, processed: 1, changed: 1, dry_run: true });
    expect(body.filter_sweep).toBeNull();
    expect(db.db.query(`SELECT verification_code FROM messages`).get()).toEqual({
      verification_code: '000000',
    });
  });

  test('a changing run rewrites the codes and then judges the pending messages', async () => {
    const { handler } = registeredHandler();
    const db = database([
      { id: 'm1', content: 'Your code is 123456', verification_code: '000000' },
    ]);

    const response = await handler(request(db));
    const body = await bodyOf(response);

    expect(body).toMatchObject({ success: true, changed: 1, dry_run: false });
    expect(body.filter_sweep).toMatchObject({ processed: 1 });
    expect(db.db.query(`SELECT verification_code, filter_status FROM messages`).get()).toEqual({
      verification_code: '123456',
      filter_status: 'clean',
    });
  });

  test('a run with nothing to change does not sweep', async () => {
    const { handler } = registeredHandler();
    const db = database([
      { id: 'm1', content: 'Your code is 123456', verification_code: '123456' },
    ]);

    const body = await bodyOf(await handler(request(db)));

    expect(body).toMatchObject({ success: true, processed: 1, changed: 0 });
    expect(body.filter_sweep).toBeNull();
  });

  test('answers 500 when the scan fails', async () => {
    const { handler } = registeredHandler();
    const db = database([]);
    db.db.run('DROP TABLE messages');

    const response = await handler(request(db));

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: 'Failed to reprocess verification codes' });
  });
});
