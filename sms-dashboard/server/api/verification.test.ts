import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { memoryKv } from '../../test/memory-kv.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { callWorker } from '../../test/worker-harness.js';

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

const ADMIN = 'session-admin';
const VIEWER = 'session-viewer';

function session(roles: string[]): string {
  return JSON.stringify({
    user: { id: 'auth0|u', email: 'someone@example.test', roles },
    expires_at: Date.now() + 3_600_000,
  });
}

const SESSIONS = memoryKv({
  [ADMIN]: session(['sms-admin']),
  [VIEWER]: session(['sms-viewer']),
});

async function reprocess(
  db: ReturnType<typeof database>,
  { query = '', token = ADMIN } = {},
): Promise<Response> {
  const { response } = await callWorker('POST', `/api/verification/reprocess${query}`, {
    headers: { Cookie: `auth_token=${token}` },
    bindings: { DB: db, SESSIONS },
  });
  return response;
}

const Body = v.looseObject({
  success: v.optional(v.boolean()),
  error: v.optional(v.string()),
  processed: v.optional(v.number()),
  changed: v.optional(v.number()),
  dry_run: v.optional(v.boolean()),
  filter_sweep: v.optional(v.nullable(v.looseObject({ processed: v.number() }))),
});

const Problem = v.looseObject({ detail: v.string(), code: v.string() });

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return v.parse(Problem, await response.json());
}

async function bodyOf(response: Response) {
  return v.parse(Body, await response.json());
}

describe('POST /api/verification/reprocess', () => {
  test('answers 401 without a credential the middleware accepts', async () => {
    const response = await reprocess(database([]), { token: 'unknown' });
    expect(response.status).toBe(401);
  });

  test('answers 403 to a role without filters.write', async () => {
    const response = await reprocess(database([]), { token: VIEWER });
    expect(response.status).toBe(403);
  });

  test('a dry run reports the changes and writes nothing', async () => {
    const db = database([
      { id: 'm1', content: 'Your code is 123456', verification_code: '000000' },
    ]);

    const response = await reprocess(db, { query: '?dry_run=1' });
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, processed: 1, changed: 1, dry_run: true });
    expect(body.filter_sweep).toBeNull();
    expect(db.db.query(`SELECT verification_code FROM messages`).get()).toEqual({
      verification_code: '000000',
    });
  });

  test('a changing run rewrites the codes and then judges the pending messages', async () => {
    const db = database([
      { id: 'm1', content: 'Your code is 123456', verification_code: '000000' },
    ]);

    const response = await reprocess(db);
    const body = await bodyOf(response);

    expect(body).toMatchObject({ success: true, changed: 1, dry_run: false });
    expect(body.filter_sweep).toMatchObject({ processed: 1 });
    expect(db.db.query(`SELECT verification_code, filter_status FROM messages`).get()).toEqual({
      verification_code: '123456',
      filter_status: 'clean',
    });
  });

  test('a run with nothing to change does not sweep', async () => {
    const db = database([
      { id: 'm1', content: 'Your code is 123456', verification_code: '123456' },
    ]);

    const body = await bodyOf(await reprocess(db));

    expect(body).toMatchObject({ success: true, processed: 1, changed: 0 });
    expect(body.filter_sweep).toBeNull();
  });

  test('answers 500 when the scan fails', async () => {
    const db = database([]);
    db.db.run('DROP TABLE messages');

    const response = await reprocess(db);

    expect(response.status).toBe(500);
    expect(await problemOf(response)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to reprocess verification codes',
    });
  });
});
