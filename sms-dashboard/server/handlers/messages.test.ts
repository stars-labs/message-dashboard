import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1RunResult, D1Statement } from '../lib/d1.js';
import { messagesHandler } from './messages.js';

type Row = Record<string, unknown>;

function messageRow(overrides: Row = {}): Row {
  return {
    id: 'message-1',
    phone_iccid: 'iccid-1',
    phone_number: null,
    content: 'test',
    timestamp: null,
    type: null,
    status: null,
    recipient: null,
    verification_code: null,
    created_at: null,
    updated_at: null,
    error_message: null,
    sms_id: null,
    filter_status: 'clean',
    filter_rule_id: null,
    purpose: 'user',
    balance_check_id: null,
    processing_session_id: null,
    ...overrides,
  };
}

interface Call {
  operation: 'all' | 'first';
  sql: string;
  params: unknown[];
}

function dbStub({
  messages = [],
  devices = [],
  statusChanges = null,
}: { messages?: Row[]; devices?: Row[]; statusChanges?: Row[] | null } = {}) {
  const calls: Call[] = [];

  function rowsFor(sql: string): Row[] {
    if (sql.includes('FROM device_view')) return devices;
    // The outbound status-refresh query, kept separate from the page above it.
    if (statusChanges && sql.includes("m.type = 'sent'")) return statusChanges;
    return messages;
  }

  function statement(sql: string, params: unknown[] = []): D1Statement<'all' | 'first'> {
    return {
      bind: (...nextParams) => statement(sql, nextParams),
      all: () => {
        calls.push({ operation: 'all', sql, params });
        return Promise.resolve({ results: rowsFor(sql) });
      },
      first: () => {
        calls.push({ operation: 'first', sql, params });
        return Promise.resolve(null);
      },
    };
  }

  const db: D1<'all' | 'first'> = { prepare: (sql) => statement(sql) };
  return { db, calls };
}

function listRequest(db: D1<'all'>, query = '') {
  return { url: `https://example.com/api/messages${query}`, env: { DB: db } };
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

function call(calls: Call[], index: number): Call {
  const found = calls[index];
  if (!found) throw new Error(`expected call ${String(index)}`);
  return found;
}

describe('message list D1 reads', () => {
  test('incremental sync bounds the list by ingestion time without a joined device scan', async () => {
    const { db, calls } = dbStub({ messages: [messageRow()] });
    const since = '2026-09-02T00:00:00.000Z';

    const response = await messagesHandler.list(
      listRequest(db, `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`),
    );
    const body = await listBody(response);

    expect(response.status).toBe(200);
    // Page, outbound status refresh, then one device_view enrichment.
    expect(calls).toHaveLength(3);
    expect(call(calls, 0).operation).toBe('all');
    expect(call(calls, 0).sql).toContain("m.created_at >= datetime(?, '-2 seconds')");
    expect(call(calls, 0).sql).toContain('ORDER BY m.created_at DESC, m.id DESC');
    expect(call(calls, 0).sql).not.toContain('JOIN device_view');
    expect(call(calls, 0).params).toContain(since);
    expect(call(calls, 2).sql).toContain('FROM device_view');
    expect(call(calls, 2).params).toEqual(['iccid-1']);
    expect(body.sync.is_incremental).toBe(true);
    expect(new Date(body.sync.server_time).toString()).not.toBe('Invalid Date');
    expect(body.pagination).not.toHaveProperty('total');
    expect(body.pagination).not.toHaveProperty('filtered_count');
  });

  test('full sync uses one extra row instead of scanning exact inbox counts', async () => {
    const messages = Array.from({ length: 101 }, (_, index) =>
      messageRow({ id: `message-${String(index)}` }),
    );
    const { db, calls } = dbStub({ messages });

    const response = await messagesHandler.list(listRequest(db, '?limit=100'));
    const body = await listBody(response);

    expect(response.status).toBe(200);
    expect(calls.every((each) => !/COUNT\s*\(|SUM\s*\(/i.test(each.sql))).toBe(true);
    expect(call(calls, 0).params.slice(-2)).toEqual([101, 0]);
    expect(body.data).toHaveLength(100);
    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_offset).toBe(100);
    expect(body.pagination).not.toHaveProperty('total');
    expect(body.pagination).not.toHaveProperty('filtered_count');
    expect(body.sync.is_incremental).toBe(false);
  });

  test('enriches only the returned page ICCIDs after the bounded message query', async () => {
    const { db, calls } = dbStub({
      messages: [
        messageRow({ id: 'message-1', phone_iccid: 'iccid-1', phone_number: 'sender-1' }),
        messageRow({ id: 'message-2', phone_iccid: 'iccid-1', phone_number: 'sender-2' }),
        messageRow({ id: 'message-3', phone_iccid: null, phone_number: 'sender-3' }),
      ],
      devices: [
        {
          iccid: 'iccid-1',
          number: '+6512345678',
          carrier: 'Singtel',
          sim_status: 'active',
          sim_index: 1,
          country: 'SG',
        },
      ],
    });

    const response = await messagesHandler.list(listRequest(db, '?limit=100'));
    const body = await listBody(response);

    expect(calls).toHaveLength(2);
    expect(call(calls, 0).sql).not.toContain('JOIN device_view');
    expect(call(calls, 1).sql).toContain('WHERE iccid IN (?)');
    expect(call(calls, 1).params).toEqual(['iccid-1']);
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
    const messages = Array.from({ length: 101 }, (_, index) =>
      messageRow({
        id: `message-${String(index).padStart(3, '0')}`,
        created_at: `2026-09-02 00:00:${String(index % 60).padStart(2, '0')}`,
      }),
    );
    const { db, calls } = dbStub({ messages });
    const since = '2026-09-01T23:00:00.000Z';
    const until = '2026-09-02T01:00:00.000Z';

    const response = await messagesHandler.list(
      listRequest(
        db,
        `?limit=100&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      ),
    );
    const body = await listBody(response);

    expect(response.status).toBe(200);
    expect(call(calls, 0).sql).toContain('m.created_at <= datetime(?)');
    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_cursor).toEqual({
      created_at: '2026-09-02 00:00:39',
      id: 'message-099',
    });
    expect(body.sync.server_time).toBe(until);
  });

  test('continues incremental pages strictly before the last delivered key', async () => {
    const { db, calls } = dbStub();
    const beforeCreatedAt = '2026-09-02 00:00:10';
    const beforeId = 'message-100';

    const response = await messagesHandler.list(
      listRequest(
        db,
        `?since=2026-09-01T23%3A00%3A00.000Z&until=2026-09-02T01%3A00%3A00.000Z&before_created_at=${encodeURIComponent(beforeCreatedAt)}&before_id=${beforeId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(call(calls, 0).sql).toContain('m.created_at < ?');
    expect(call(calls, 0).sql).toContain('(m.created_at = ? AND m.id < ?)');
    expect(call(calls, 0).params).toContain(beforeCreatedAt);
    expect(call(calls, 0).params).toContain(beforeId);
  });

  test('chunks device enrichment below D1s 100-bound-parameter limit', async () => {
    const messages = Array.from({ length: 205 }, (_, index) =>
      messageRow({ id: `message-${String(index)}`, phone_iccid: `iccid-${String(index)}` }),
    );
    const { db, calls } = dbStub({ messages });

    const response = await messagesHandler.list(listRequest(db, '?limit=205'));

    expect(response.status).toBe(200);
    const enrichmentCalls = calls.filter(({ sql }) => sql.includes('FROM device_view'));
    expect(enrichmentCalls).toHaveLength(3);
    expect(enrichmentCalls.every(({ params }) => params.length <= 100)).toBe(true);
  });

  test('rejects incremental requests with a bad timestamp, offset or cursor', async () => {
    const { db, calls } = dbStub();
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
    for (const [query, error] of cases) {
      const response = await messagesHandler.list(listRequest(db, query));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ success: false, error });
    }
    expect(calls).toHaveLength(0);
  });

  test('answers 500 when a row does not match the messages schema', async () => {
    const { db } = dbStub({ messages: [messageRow({ filter_rule_id: 'x' })] });

    const response = await messagesHandler.list(listRequest(db));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: 'Failed to fetch messages' });
  });
});

describe('message list on SQLite', () => {
  interface InboxRow {
    id: string;
    phone_iccid?: string;
    timestamp?: string;
    type?: string;
    created_at?: string;
    updated_at?: string;
    filter_status?: string;
    purpose?: string;
  }

  function inbox(rows: InboxRow[]) {
    const d1 = sqliteD1();
    d1.db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp DATETIME,
      type TEXT,
      status TEXT,
      recipient TEXT,
      verification_code TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      error_message TEXT,
      sms_id TEXT,
      filter_status TEXT NOT NULL DEFAULT 'pending',
      filter_rule_id INTEGER,
      purpose TEXT NOT NULL DEFAULT 'user',
      balance_check_id TEXT,
      processing_session_id TEXT
    )`);
    d1.db.run(`CREATE TABLE device_view (
      iccid TEXT, number TEXT, carrier TEXT, sim_status TEXT, sim_index INTEGER, country TEXT
    )`);
    d1.db.run(
      `INSERT INTO device_view VALUES ('iccid-1', '+6512345678', 'Singtel', 'active', 1, 'SG')`,
    );
    for (const row of rows) {
      d1.db
        .query(
          `INSERT INTO messages (id, phone_iccid, content, timestamp, type,
             created_at, updated_at, filter_status, purpose)
           VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.phone_iccid ?? 'iccid-1',
          row.timestamp ?? '2026-09-02 00:00:00',
          row.type ?? 'received',
          row.created_at ?? '2026-09-02 00:00:00',
          row.updated_at ?? '2026-09-02 00:00:00',
          row.filter_status ?? 'clean',
          row.purpose ?? 'user',
        );
    }
    return d1;
  }

  async function idsOf(d1: ReturnType<typeof inbox>, query: string): Promise<string[]> {
    const response = await messagesHandler.list(listRequest(d1, query));
    expect(response.status).toBe(200);
    return (await listBody(response)).data.map((message) => message.id);
  }

  test('hides spam and carrier maintenance traffic unless spam is requested', async () => {
    const d1 = inbox([
      { id: 'clean', filter_status: 'clean', timestamp: '2026-09-02 00:00:03' },
      { id: 'pending', filter_status: 'pending', timestamp: '2026-09-02 00:00:02' },
      { id: 'spam', filter_status: 'spam', timestamp: '2026-09-02 00:00:01' },
      { id: 'balance', purpose: 'balance', filter_status: 'clean' },
    ]);

    expect(await idsOf(d1, '')).toEqual(['clean', 'pending']);
    expect(await idsOf(d1, '?include_filtered=1')).toEqual(['clean', 'pending', 'spam']);
  });

  test('pages by offset, newest first, and reports the next offset', async () => {
    const d1 = inbox(
      ['a', 'b', 'c'].map((id, index) => ({
        id,
        timestamp: `2026-09-02 00:00:0${String(3 - index)}`,
      })),
    );

    const response = await messagesHandler.list(listRequest(d1, '?limit=2'));
    const body = await listBody(response);

    expect(body.data.map((message) => message.id)).toEqual(['a', 'b']);
    expect(body.pagination).toMatchObject({ has_more: true, next_offset: 2 });
    expect(await idsOf(d1, '?limit=2&offset=2')).toEqual(['c']);
  });

  test('filters by SIM and fills in the device columns', async () => {
    const d1 = inbox([
      { id: 'mine', phone_iccid: 'iccid-1' },
      { id: 'other', phone_iccid: 'iccid-2' },
    ]);

    const response = await messagesHandler.list(listRequest(d1, '?phone_iccid=iccid-1'));
    const body = await response.json();

    expect(body).toMatchObject({
      data: [
        {
          id: 'mine',
          display_phone_number: '+6512345678',
          phone_carrier: 'Singtel',
          phone_sim_index: 1,
        },
      ],
    });
  });

  test('incremental pages walk the keyset cursor without repeating a row', async () => {
    const d1 = inbox(
      ['m1', 'm2', 'm3'].map((id, index) => ({
        id,
        created_at: `2026-09-02 00:00:0${String(index)}`,
      })),
    );
    const window = 'since=2026-09-02T00%3A00%3A00.000Z&until=2026-09-02T01%3A00%3A00.000Z';

    const first = await listBody(await messagesHandler.list(listRequest(d1, `?limit=2&${window}`)));
    expect(first.data.map((message) => message.id)).toEqual(['m3', 'm2']);
    expect(first.pagination.next_cursor).toEqual({ created_at: '2026-09-02 00:00:01', id: 'm2' });

    const second = await idsOf(
      d1,
      `?limit=2&${window}&before_created_at=${encodeURIComponent('2026-09-02 00:00:01')}&before_id=m2`,
    );
    expect(second).toEqual(['m1']);
  });

  test('an incremental sync also delivers a sent row whose status moved', async () => {
    const d1 = inbox([
      {
        id: 'sent-earlier',
        type: 'sent',
        created_at: '2026-08-01 00:00:00',
        updated_at: '2026-09-02 00:00:05',
      },
      { id: 'sent-quiet', type: 'sent', created_at: '2026-08-01 00:00:00' },
    ]);
    d1.db.run(`UPDATE messages SET updated_at = '2026-08-01 00:00:00' WHERE id = 'sent-quiet'`);

    const response = await messagesHandler.list(
      listRequest(d1, '?since=2026-09-02T00%3A00%3A00.000Z&until=2026-09-02T01%3A00%3A00.000Z'),
    );
    const body = await listBody(response);

    expect(body.data.map((message) => message.id)).toEqual(['sent-earlier']);
    expect(body.sync.status_refreshed).toBe(1);
  });
});

describe('outbound status changes reach the dashboard', () => {
  const since = '2026-09-02T00:00:00.000Z';

  test('an incremental sync carries an already-known row whose status moved', async () => {
    const { db, calls } = dbStub({
      messages: [messageRow({ id: 'new-inbound', content: 'code 1234' })],
      statusChanges: [
        messageRow({
          id: 'sent-earlier',
          type: 'sent',
          status: 'sent',
          content: 'hello',
        }),
      ],
    });

    const response = await messagesHandler.list(
      listRequest(db, `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`),
    );
    const body = await listBody(response);

    const refresh = calls.find((each) => each.sql.includes("m.type = 'sent'"));
    expect(refresh).toBeTruthy();
    expect(refresh?.sql).toContain("m.updated_at >= datetime(?, '-2 seconds')");
    expect(refresh?.sql).toContain('ORDER BY m.updated_at DESC');
    expect(refresh?.params).toContain(since);
    expect(refresh?.params).toContain('iccid-1');

    expect(body.data.map((message) => message.id)).toEqual(['new-inbound', 'sent-earlier']);
    expect(body.sync.status_refreshed).toBe(1);
  });

  test('a row already in the page is not sent twice', async () => {
    const row = messageRow({ id: 'same-row', type: 'sent', status: 'sent' });
    const { db } = dbStub({ messages: [row], statusChanges: [row] });

    const response = await messagesHandler.list(
      listRequest(db, `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`),
    );
    const body = await listBody(response);

    expect(body.data.map((message) => message.id)).toEqual(['same-row']);
    expect(body.sync.status_refreshed).toBe(0);
  });

  test('a full load does not run the refresh query', async () => {
    const { db, calls } = dbStub({
      messages: [],
      statusChanges: [messageRow({ id: 'x', type: 'sent' })],
    });

    await messagesHandler.list(listRequest(db, '?phone_iccid=iccid-1&limit=50'));

    expect(calls.some((each) => each.sql.includes("m.type = 'sent'"))).toBe(false);
  });
});

describe('message get', () => {
  test('returns one message', async () => {
    const d1 = sqliteD1();
    d1.db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, phone_iccid TEXT, phone_number TEXT, content TEXT NOT NULL,
      timestamp DATETIME, type TEXT, status TEXT, recipient TEXT, verification_code TEXT,
      created_at DATETIME, updated_at DATETIME, error_message TEXT, sms_id TEXT,
      filter_status TEXT NOT NULL DEFAULT 'pending', filter_rule_id INTEGER,
      purpose TEXT NOT NULL DEFAULT 'user', balance_check_id TEXT, processing_session_id TEXT
    )`);
    d1.db.run(`INSERT INTO messages (id, content, verification_code) VALUES ('m1', 'hi', '1234')`);

    const found = await messagesHandler.get({ env: { DB: d1 }, params: { id: 'm1' } });
    const missing = await messagesHandler.get({ env: { DB: d1 }, params: { id: 'nope' } });
    const noId = await messagesHandler.get({ env: { DB: d1 } });

    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      success: true,
      data: messageRow({
        id: 'm1',
        phone_iccid: null,
        content: 'hi',
        verification_code: '1234',
        filter_status: 'pending',
      }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ success: false, error: 'Message not found' });
    expect(noId.status).toBe(500);
    expect(await noId.json()).toEqual({ success: false, error: 'Failed to fetch message' });
  });
});

describe('message send', () => {
  function sendDb({
    active = { number: '+6512345678' },
    any = null,
    runError = null,
  }: {
    active?: Row | null;
    any?: Row | null;
    runError?: Error | null;
  } = {}) {
    const inserts: { sql: string; params: unknown[] }[] = [];
    const db: D1<'first' | 'run'> = {
      prepare(sql) {
        const statement = (params: unknown[]): D1Statement<'first' | 'run'> => ({
          bind: (...next) => statement(next),
          first: () => Promise.resolve(sql.includes("sim_status = 'active'") ? active : any),
          run: () => {
            if (runError) return Promise.reject(runError);
            inserts.push({ sql, params });
            const result: D1RunResult = { meta: { changes: 1, last_row_id: 1 } };
            return Promise.resolve(result);
          },
        });
        return statement([]);
      },
    };
    return { db, inserts };
  }

  function sendRequest(db: D1<'first' | 'run'>, body: unknown) {
    return {
      env: { DB: db },
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }

  const valid = { phone_iccid: 'iccid-1', recipient: '+6587654321', content: 'hello' };

  const SentBody = v.object({
    success: v.boolean(),
    messageId: v.string(),
    data: v.looseObject({ timestamp: v.string() }),
  });

  const ErrorBody = v.object({ success: v.literal(false), error: v.string() });

  async function errorOf(response: Response): Promise<string> {
    return v.parse(ErrorBody, await response.json()).error;
  }

  test('stores a sending message addressed to the normalised recipient', async () => {
    const { db, inserts } = sendDb();
    const response = await messagesHandler.send(sendRequest(db, valid));
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
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toEqual([
      body.messageId,
      'iccid-1',
      '+6512345678',
      'hello',
      body.data.timestamp,
      '+6587654321',
    ]);
  });

  test('answers 400 when a required field is missing or empty', async () => {
    for (const bad of [
      { ...valid, phone_iccid: undefined },
      { ...valid, recipient: '' },
      { ...valid, content: '' },
      {},
    ]) {
      const response = await messagesHandler.send(sendRequest(sendDb().db, bad));
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatch(/^Missing required fields/);
    }
  });

  test('answers 400 for a recipient that is not a phone number', async () => {
    const response = await messagesHandler.send(
      sendRequest(sendDb().db, { ...valid, recipient: '+65123\r\nAT+CMGD=1' }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatch(/^Invalid recipient: /);
  });

  test('answers 400 when the SIM is unknown', async () => {
    const response = await messagesHandler.send(sendRequest(sendDb({ active: null }).db, valid));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("Phone with ICCID 'iccid-1' not found in database");
  });

  test('answers 400 when the SIM is not active', async () => {
    const response = await messagesHandler.send(
      sendRequest(
        sendDb({ active: null, any: { iccid: 'iccid-1', sim_status: 'offline' } }).db,
        valid,
      ),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("Phone found but status is 'offline' (not active)");
  });

  test('answers 500 when the message cannot be stored', async () => {
    const response = await messagesHandler.send(
      sendRequest(sendDb({ runError: new Error('D1 down') }).db, valid),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: 'Failed to send message' });
  });

  test('answers 400 for a body that is not JSON', async () => {
    const response = await messagesHandler.send(sendRequest(sendDb().db, 'not json'));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatch(/^Missing required fields/);
  });

  test('answers 400 for fields that are not strings instead of sending their text', async () => {
    for (const bad of [
      { ...valid, content: { text: 'hi' } },
      { ...valid, phone_iccid: 8986 },
      { ...valid, recipient: 6587654321 },
    ]) {
      const { db, inserts } = sendDb();
      const response = await messagesHandler.send(sendRequest(db, bad));
      expect(response.status).toBe(400);
      expect(inserts).toHaveLength(0);
    }
  });
});
