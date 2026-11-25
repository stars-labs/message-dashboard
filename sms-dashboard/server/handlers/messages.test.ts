import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { memoryKv } from '../../test/memory-kv.js';
import { createSchema } from '../../test/schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { callWorker } from '../../test/worker-harness.js';
import type { D1Statement } from '../lib/d1.js';

let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

const ADMIN = 'session-admin';
const VIEWER = 'session-viewer';

function session(roles: string[]): string {
  return JSON.stringify({
    user: { id: 'auth0|admin', email: 'someone@example.test', roles },
    expires_at: Date.now() + 3_600_000,
  });
}

const SESSIONS = memoryKv({
  [ADMIN]: session(['sms-admin']),
  [VIEWER]: session(['sms-viewer']),
});

interface Executed {
  sql: string;
  params: unknown[];
}

interface MessageSeed {
  id: string;
  phone_iccid?: string | null;
  phone_number?: string;
  content?: string;
  timestamp?: string;
  type?: string;
  created_at?: string;
  updated_at?: string;
  filter_status?: string;
  purpose?: string;
}

async function database(messages: MessageSeed[] = []) {
  const sqlite = new Database(':memory:');
  await createSchema(sqlite);
  const d1 = sqliteD1(sqlite);
  for (const message of messages) {
    d1.db
      .query(
        `INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type,
           created_at, updated_at, filter_status, purpose)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.phone_iccid === undefined ? 'iccid-1' : message.phone_iccid,
        message.phone_number ?? null,
        message.content ?? 'test',
        message.timestamp ?? '2026-09-02 00:00:00',
        message.type ?? 'received',
        message.created_at ?? '2026-09-02 00:00:00',
        message.updated_at ?? '2026-09-02 00:00:00',
        message.filter_status ?? 'clean',
        message.purpose ?? 'user',
      );
  }
  const executed: Executed[] = [];
  const wrap = (sql: string, statement: D1Statement, params: unknown[]): D1Statement => {
    const record = () => executed.push({ sql: sql.replaceAll(/\s+/g, ' ').trim(), params });
    return {
      bind: (...values) => wrap(sql, statement.bind(...values), values),
      all: () => {
        record();
        return statement.all();
      },
      first: () => {
        record();
        return statement.first();
      },
      run: () => {
        record();
        return statement.run();
      },
    };
  };
  return {
    d1: { ...d1, prepare: (sql: string) => wrap(sql, d1.prepare(sql), []) },
    db: d1.db,
    executed,
  };
}

type TestDb = Awaited<ReturnType<typeof database>>;

// device_view reports the SIM active while its modem is connected and reads it,
// offline once the modem disconnects.
function addDevice(
  { db }: TestDb,
  device: { iccid: string; number: string; carrier: string; online: boolean; country: string },
) {
  db.query(
    `INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier, imei)
     VALUES (?, 1, ?, ?, ?, 'imei-1')`,
  ).run(device.iccid, device.number, device.country, device.carrier);
  db.query(`INSERT INTO modems (equipment_id, status, detected_iccid) VALUES ('imei-1', ?, ?)`).run(
    device.online ? 'connected' : 'disconnected',
    device.iccid,
  );
}

const SINGTEL = {
  iccid: 'iccid-1',
  number: '+6512345678',
  carrier: 'Singtel',
  online: true,
  country: 'SG',
};

async function call(
  { d1 }: TestDb,
  method: string,
  path: string,
  { body, token = ADMIN }: { body?: string; token?: string } = {},
): Promise<Response> {
  const { response } = await callWorker(method, path, {
    headers: {
      Cookie: `auth_token=${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
    bindings: { DB: d1, SESSIONS },
  });
  return response;
}

const Problem = v.looseObject({
  type: v.string(),
  title: v.string(),
  status: v.number(),
  detail: v.string(),
  code: v.string(),
});

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return v.parse(Problem, await response.json());
}

const ListBody = v.object({
  success: v.boolean(),
  data: v.array(v.looseObject({ id: v.string() })),
  pagination: v.looseObject({
    has_more: v.boolean(),
    next_offset: v.nullable(v.number()),
    next_cursor: v.nullable(v.object({ created_at: v.nullable(v.string()), id: v.string() })),
  }),
  sync: v.looseObject({
    server_time: v.string(),
    is_incremental: v.boolean(),
    status_refreshed: v.number(),
  }),
});

async function listBody(response: Response) {
  return v.parse(ListBody, await response.json());
}

function list(db: TestDb, query = '', token = ADMIN) {
  return call(db, 'GET', `/api/messages${query}`, { token });
}

async function idsOf(db: TestDb, query: string): Promise<string[]> {
  const response = await list(db, query);
  expect(response.status).toBe(200);
  return (await listBody(response)).data.map((message) => message.id);
}

function executedAt(db: TestDb, index: number): Executed {
  const found = db.executed[index];
  if (!found) throw new Error(`expected statement ${String(index)}`);
  return found;
}

function stamp(index: number): string {
  const minutes = String(Math.floor(index / 60)).padStart(2, '0');
  return `2026-09-02 00:${minutes}:${String(index % 60).padStart(2, '0')}`;
}

describe('message list D1 reads', () => {
  test('incremental sync bounds the list by ingestion time without a joined device scan', async () => {
    const db = await database([{ id: 'message-1' }]);
    const since = '2026-09-02T00:00:00.000Z';

    const response = await list(
      db,
      `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`,
    );
    const body = await listBody(response);

    expect(response.status).toBe(200);
    expect(db.executed).toHaveLength(3);
    expect(executedAt(db, 0).sql).toContain("m.created_at >= datetime(?, '-2 seconds')");
    expect(executedAt(db, 0).sql).toContain('ORDER BY m.created_at DESC, m.id DESC');
    expect(executedAt(db, 0).sql).not.toContain('JOIN device_view');
    expect(executedAt(db, 0).params).toContain(since);
    expect(executedAt(db, 2).sql).toContain('FROM device_view');
    expect(executedAt(db, 2).params).toEqual(['iccid-1']);
    expect(body.sync.is_incremental).toBe(true);
    expect(new Date(body.sync.server_time).toString()).not.toBe('Invalid Date');
    expect(body.pagination).not.toHaveProperty('total');
    expect(body.pagination).not.toHaveProperty('filtered_count');
  });

  test('full sync uses one extra row instead of scanning exact inbox counts', async () => {
    const db = await database(
      Array.from({ length: 101 }, (_, index) => ({
        id: `message-${String(index)}`,
        timestamp: stamp(index),
      })),
    );

    const response = await list(db, '?limit=100');
    const body = await listBody(response);

    expect(response.status).toBe(200);
    expect(db.executed.every((each) => !/COUNT\s*\(|SUM\s*\(/i.test(each.sql))).toBe(true);
    expect(executedAt(db, 0).params.slice(-2)).toEqual([101, 0]);
    expect(body.data).toHaveLength(100);
    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_offset).toBe(100);
    expect(body.pagination).not.toHaveProperty('total');
    expect(body.pagination).not.toHaveProperty('filtered_count');
    expect(body.sync.is_incremental).toBe(false);
  });

  test('enriches only the returned page ICCIDs after the bounded message query', async () => {
    const db = await database([
      { id: 'message-1', phone_iccid: 'iccid-1', phone_number: 'sender-1', timestamp: stamp(3) },
      { id: 'message-2', phone_iccid: 'iccid-1', phone_number: 'sender-2', timestamp: stamp(2) },
      { id: 'message-3', phone_iccid: null, phone_number: 'sender-3', timestamp: stamp(1) },
    ]);
    addDevice(db, SINGTEL);

    const response = await list(db, '?limit=100');
    const body = await listBody(response);

    expect(db.executed).toHaveLength(2);
    expect(executedAt(db, 0).sql).not.toContain('JOIN device_view');
    expect(executedAt(db, 1).sql).toContain('WHERE iccid IN (?)');
    expect(executedAt(db, 1).params).toEqual(['iccid-1']);
    expect(body.data[0]).toMatchObject({
      display_phone_number: '+6512345678',
      phone_carrier: 'Singtel',
      phone_status: 'active',
      phone_sim_index: 1,
      phone_country: 'SG',
      mapped_number: null,
    });
    expect(body.data[2]).toMatchObject({ display_phone_number: 'sender-3' });
    expect(body.pagination.has_more).toBe(false);
    expect(body.pagination.next_offset).toBeNull();
  });

  test('returns a stable keyset cursor for every incremental backlog page', async () => {
    const db = await database(
      Array.from({ length: 101 }, (_, index) => ({
        id: `message-${String(index).padStart(3, '0')}`,
        created_at: stamp(index),
      })),
    );
    const since = '2026-09-01T23:00:00.000Z';
    const until = '2026-09-02T01:00:00.000Z';

    const response = await list(
      db,
      `?limit=100&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    );
    const body = await listBody(response);

    expect(response.status).toBe(200);
    expect(executedAt(db, 0).sql).toContain('m.created_at <= datetime(?)');
    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_cursor).toEqual({ created_at: stamp(1), id: 'message-001' });
    expect(body.sync.server_time).toBe(until);
  });

  test('continues incremental pages strictly before the last delivered key', async () => {
    const db = await database();
    const beforeCreatedAt = '2026-09-02 00:00:10';
    const beforeId = 'message-100';

    const response = await list(
      db,
      `?since=2026-09-01T23%3A00%3A00.000Z&until=2026-09-02T01%3A00%3A00.000Z&before_created_at=${encodeURIComponent(beforeCreatedAt)}&before_id=${beforeId}`,
    );

    expect(response.status).toBe(200);
    expect(executedAt(db, 0).sql).toContain('m.created_at < ?');
    expect(executedAt(db, 0).sql).toContain('(m.created_at = ? AND m.id < ?)');
    expect(executedAt(db, 0).params).toContain(beforeCreatedAt);
    expect(executedAt(db, 0).params).toContain(beforeId);
  });

  test('chunks device enrichment below D1s 100-bound-parameter limit', async () => {
    const db = await database(
      Array.from({ length: 205 }, (_, index) => ({
        id: `message-${String(index)}`,
        phone_iccid: `iccid-${String(index)}`,
        timestamp: stamp(index),
      })),
    );

    const response = await list(db, '?limit=205');

    expect(response.status).toBe(200);
    const enrichment = db.executed.filter(({ sql }) => sql.includes('FROM device_view'));
    expect(enrichment).toHaveLength(3);
    expect(enrichment.every(({ params }) => params.length <= 100)).toBe(true);
  });

  test('rejects incremental requests with a bad timestamp, offset or cursor', async () => {
    const db = await database();
    const cases = [
      ['?since=garbage', 'Invalid since timestamp'],
      ['?since=2026-09-02T00:00:00Z&offset=5', 'Incremental sync uses a keyset cursor, not offset'],
      ['?since=2026-09-02T00:00:00Z&until=garbage', 'Invalid until timestamp'],
      ['?since=2026-09-02T00:00:00Z&before_id=x', 'Invalid incremental page cursor'],
      [
        '?since=2026-09-02T00:00:00Z&before_created_at=garbage&before_id=x',
        'Invalid incremental page cursor',
      ],
    ] as const;
    for (const [query, detail] of cases) {
      const response = await list(db, query);
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({ code: 'BAD_REQUEST', detail });
    }
    expect(db.executed).toHaveLength(0);
  });

  test('answers 500 when a row does not match the messages schema', async () => {
    const db = await database([{ id: 'message-1' }]);
    db.db.run(`UPDATE messages SET content = X'00' WHERE id = 'message-1'`);

    const response = await list(db);

    expect(response.status).toBe(500);
    expect(await problemOf(response)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to fetch messages',
    });
  });
});

describe('GET /api/messages authorization', () => {
  test('a viewer may read messages', async () => {
    expect((await list(await database(), '', VIEWER)).status).toBe(200);
  });

  test('answers 401 without a credential the middleware accepts', async () => {
    expect((await list(await database(), '', 'unknown')).status).toBe(401);
  });
});

describe('message list on SQLite', () => {
  test('hides spam and carrier maintenance traffic unless spam is requested', async () => {
    const db = await database([
      { id: 'clean', filter_status: 'clean', timestamp: '2026-09-02 00:00:03' },
      { id: 'pending', filter_status: 'pending', timestamp: '2026-09-02 00:00:02' },
      { id: 'spam', filter_status: 'spam', timestamp: '2026-09-02 00:00:01' },
      { id: 'balance', purpose: 'balance_maintenance', filter_status: 'clean' },
    ]);

    expect(await idsOf(db, '')).toEqual(['clean', 'pending']);
    expect(await idsOf(db, '?include_filtered=1')).toEqual(['clean', 'pending', 'spam']);
  });

  test('pages by offset, newest first, and reports the next offset', async () => {
    const db = await database(
      ['a', 'b', 'c'].map((id, index) => ({
        id,
        timestamp: `2026-09-02 00:00:0${String(3 - index)}`,
      })),
    );

    const response = await list(db, '?limit=2');
    const body = await listBody(response);

    expect(body.data.map((message) => message.id)).toEqual(['a', 'b']);
    expect(body.pagination).toMatchObject({ has_more: true, next_offset: 2 });
    expect(await idsOf(db, '?limit=2&offset=2')).toEqual(['c']);
  });

  test('filters by SIM and fills in the device columns', async () => {
    const db = await database([
      { id: 'mine', phone_iccid: 'iccid-1' },
      { id: 'other', phone_iccid: 'iccid-2' },
    ]);
    addDevice(db, SINGTEL);

    const body = await listBody(await list(db, '?phone_iccid=iccid-1'));

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'mine',
      display_phone_number: '+6512345678',
      phone_carrier: 'Singtel',
      phone_sim_index: 1,
    });
  });

  test('incremental pages walk the keyset cursor without repeating a row', async () => {
    const db = await database(
      ['m1', 'm2', 'm3'].map((id, index) => ({
        id,
        created_at: `2026-09-02 00:00:0${String(index)}`,
      })),
    );
    const window = 'since=2026-09-02T00%3A00%3A00.000Z&until=2026-09-02T01%3A00%3A00.000Z';

    const first = await listBody(await list(db, `?limit=2&${window}`));
    expect(first.data.map((message) => message.id)).toEqual(['m3', 'm2']);
    expect(first.pagination.next_cursor).toEqual({ created_at: '2026-09-02 00:00:01', id: 'm2' });

    const second = await idsOf(
      db,
      `?limit=2&${window}&before_created_at=${encodeURIComponent('2026-09-02 00:00:01')}&before_id=m2`,
    );
    expect(second).toEqual(['m1']);
  });

  test('an incremental sync also delivers a sent row whose status moved', async () => {
    const db = await database([
      {
        id: 'sent-earlier',
        type: 'sent',
        created_at: '2026-08-01 00:00:00',
        updated_at: '2026-09-02 00:00:05',
      },
      {
        id: 'sent-quiet',
        type: 'sent',
        created_at: '2026-08-01 00:00:00',
        updated_at: '2026-08-01 00:00:00',
      },
    ]);

    const body = await listBody(
      await list(db, '?since=2026-09-02T00%3A00%3A00.000Z&until=2026-09-02T01%3A00%3A00.000Z'),
    );

    expect(body.data.map((message) => message.id)).toEqual(['sent-earlier']);
    expect(body.sync.status_refreshed).toBe(1);
  });
});

describe('outbound status changes reach the dashboard', () => {
  const since = '2026-09-02T00:00:00.000Z';
  const until = '2026-09-02T01:00:00.000Z';

  function incremental(db: TestDb) {
    return list(
      db,
      `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    );
  }

  test('an incremental sync carries an already-known row whose status moved', async () => {
    const db = await database([
      { id: 'new-inbound', content: 'code 1234', created_at: '2026-09-02 00:00:10' },
      {
        id: 'sent-earlier',
        type: 'sent',
        content: 'hello',
        created_at: '2026-08-01 00:00:00',
        updated_at: '2026-09-02 00:00:05',
      },
    ]);

    const body = await listBody(await incremental(db));

    const refresh = db.executed.find((each) => each.sql.includes("m.type = 'sent'"));
    expect(refresh).toBeTruthy();
    expect(refresh?.sql).toContain("m.updated_at >= datetime(?, '-2 seconds')");
    expect(refresh?.sql).toContain('ORDER BY m.updated_at DESC');
    expect(refresh?.params).toContain(since);
    expect(refresh?.params).toContain('iccid-1');

    expect(body.data.map((message) => message.id)).toEqual(['new-inbound', 'sent-earlier']);
    expect(body.sync.status_refreshed).toBe(1);
  });

  test('a row already in the page is not sent twice', async () => {
    const db = await database([
      {
        id: 'same-row',
        type: 'sent',
        created_at: '2026-09-02 00:00:10',
        updated_at: '2026-09-02 00:00:10',
      },
    ]);

    const body = await listBody(await incremental(db));

    expect(body.data.map((message) => message.id)).toEqual(['same-row']);
    expect(body.sync.status_refreshed).toBe(0);
  });

  test('a full load does not run the refresh query', async () => {
    const db = await database([
      {
        id: 'x',
        type: 'sent',
        created_at: '2026-09-02 00:00:10',
        updated_at: '2026-09-02 00:00:10',
      },
    ]);

    await list(db, '?phone_iccid=iccid-1&limit=50');

    expect(db.executed.some((each) => each.sql.includes("m.type = 'sent'"))).toBe(false);
  });
});

describe('POST /api/messages/send', () => {
  const valid = { phone_iccid: 'iccid-1', recipient: '+6587654321', content: 'hello' };

  function send(db: TestDb, body: unknown, token = ADMIN) {
    return call(db, 'POST', '/api/messages/send', {
      token,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  function stored({ db }: TestDb) {
    return db
      .query(
        `SELECT id, phone_iccid, phone_number, content, timestamp, type, status, recipient
         FROM messages`,
      )
      .all();
  }

  const SentBody = v.object({
    success: v.boolean(),
    messageId: v.string(),
    data: v.looseObject({ timestamp: v.string() }),
  });

  test('stores a sending message addressed to the normalised recipient', async () => {
    const db = await database();
    addDevice(db, SINGTEL);

    const response = await send(db, valid);
    const body = v.parse(SentBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.messageId).toMatch(/^msg-sent-/);
    expect(body.data).toMatchObject({
      id: body.messageId,
      phone_iccid: 'iccid-1',
      recipient: '+6587654321',
      content: 'hello',
      type: 'sent',
      status: 'pending',
    });
    expect(stored(db)).toEqual([
      {
        id: body.messageId,
        phone_iccid: 'iccid-1',
        phone_number: '+6512345678',
        content: 'hello',
        timestamp: body.data.timestamp,
        type: 'sent',
        status: 'sending',
        recipient: '+6587654321',
      },
    ]);
  });

  test('a viewer may send', async () => {
    const db = await database();
    addDevice(db, SINGTEL);

    expect((await send(db, valid, VIEWER)).status).toBe(200);
  });

  test('answers 401 without a credential the middleware accepts', async () => {
    const db = await database();
    addDevice(db, SINGTEL);

    expect((await send(db, valid, 'unknown')).status).toBe(401);
    expect(stored(db)).toEqual([]);
  });

  test('answers 400 when a required field is missing or empty', async () => {
    const db = await database();
    addDevice(db, SINGTEL);

    for (const bad of [
      { ...valid, phone_iccid: undefined },
      { ...valid, recipient: '' },
      { ...valid, content: '' },
      {},
    ]) {
      const response = await send(db, bad);
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'Missing required fields: phone_iccid, recipient, and content are required',
      });
    }
    expect(stored(db)).toEqual([]);
  });

  test('answers 400 for a recipient that is not a phone number', async () => {
    const db = await database();
    addDevice(db, SINGTEL);

    const response = await send(db, { ...valid, recipient: '+65123\r\nAT+CMGD=1' });

    expect(response.status).toBe(400);
    expect((await problemOf(response)).detail).toMatch(/^Invalid recipient: /);
    expect(stored(db)).toEqual([]);
  });

  test('answers 400 when the SIM is unknown', async () => {
    const response = await send(await database(), valid);

    expect(response.status).toBe(400);
    expect(await problemOf(response)).toMatchObject({
      code: 'BAD_REQUEST',
      detail: "Phone with ICCID 'iccid-1' not found in database",
    });
  });

  test('answers 400 when the SIM is not active', async () => {
    const db = await database();
    addDevice(db, { ...SINGTEL, online: false });

    const response = await send(db, valid);

    expect(response.status).toBe(400);
    expect(await problemOf(response)).toMatchObject({
      code: 'BAD_REQUEST',
      detail: "Phone found but status is 'offline' (not active)",
    });
  });

  test('answers 500 when the message cannot be stored', async () => {
    const db = await database();
    addDevice(db, SINGTEL);
    db.db.run('DROP TABLE messages');

    const response = await send(db, valid);

    expect(response.status).toBe(500);
    expect(await problemOf(response)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to send message',
    });
  });

  test('answers 400 for a body that is not JSON', async () => {
    const db = await database();
    addDevice(db, SINGTEL);

    const response = await send(db, 'not json');

    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('BAD_REQUEST');
  });

  test('answers 400 for fields that are not strings instead of sending their text', async () => {
    const db = await database();
    addDevice(db, SINGTEL);

    for (const bad of [
      { ...valid, content: { text: 'hi' } },
      { ...valid, phone_iccid: 8986 },
      { ...valid, recipient: 6587654321 },
    ]) {
      const response = await send(db, bad);
      expect(response.status).toBe(400);
    }
    expect(stored(db)).toEqual([]);
  });
});
