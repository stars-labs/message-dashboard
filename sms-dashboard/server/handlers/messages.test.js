import { describe, expect, test } from 'bun:test';
import { messagesHandler } from './messages.js';

function dbStub({ messages = [], devices = [], statusChanges = null } = {}) {
  const calls = [];

  function rowsFor(sql) {
    if (sql.includes('FROM device_view')) return devices;
    // The outbound status-refresh query, kept separate from the page above it.
    if (statusChanges && sql.includes("m.type = 'sent'")) return statusChanges;
    return messages;
  }

  function statement(sql, params = []) {
    return {
      bind(...nextParams) {
        return statement(sql, nextParams);
      },
      async all() {
        calls.push({ operation: 'all', sql, params });
        return { results: rowsFor(sql) };
      },
      async first() {
        calls.push({ operation: 'first', sql, params });
        return null;
      },
    };
  }

  return {
    calls,
    prepare(sql) {
      return statement(sql);
    },
  };
}

function listRequest(db, query = '') {
  const request = new Request(`https://example.com/api/messages${query}`);
  request.env = { DB: db };
  return request;
}

describe('message list D1 reads', () => {
  test('incremental sync bounds the list by ingestion time without a joined device scan', async () => {
    const db = dbStub({
      messages: [
        {
          id: 'message-1',
          phone_iccid: 'iccid-1',
          content: 'test',
        },
      ],
    });
    const since = '2026-09-02T00:00:00.000Z';

    const response = await messagesHandler.list(
      listRequest(db, `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // Page, outbound status refresh, then one device_view enrichment.
    expect(db.calls).toHaveLength(3);
    expect(db.calls[0].operation).toBe('all');
    expect(db.calls[0].sql).toContain("m.created_at >= datetime(?, '-2 seconds')");
    expect(db.calls[0].sql).toContain('ORDER BY m.created_at DESC, m.id DESC');
    expect(db.calls[0].sql).not.toContain('JOIN device_view');
    expect(db.calls[0].params).toContain(since);
    expect(db.calls[2].sql).toContain('FROM device_view');
    expect(db.calls[2].params).toEqual(['iccid-1']);
    expect(body.sync.is_incremental).toBe(true);
    expect(new Date(body.sync.server_time).toString()).not.toBe('Invalid Date');
    expect(body.pagination).not.toHaveProperty('total');
    expect(body.pagination).not.toHaveProperty('filtered_count');
  });

  test('full sync uses one extra row instead of scanning exact inbox counts', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `message-${index}`,
      phone_iccid: 'iccid-1',
    }));
    const db = dbStub({ messages });

    const response = await messagesHandler.list(listRequest(db, '?limit=100'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.calls.every((call) => !/COUNT\s*\(|SUM\s*\(/i.test(call.sql))).toBe(true);
    expect(db.calls[0].params.slice(-2)).toEqual([101, 0]);
    expect(body.data).toHaveLength(100);
    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_offset).toBe(100);
    expect(body.pagination).not.toHaveProperty('total');
    expect(body.pagination).not.toHaveProperty('filtered_count');
    expect(body.sync.is_incremental).toBe(false);
  });

  test('enriches only the returned page ICCIDs after the bounded message query', async () => {
    const db = dbStub({
      messages: [
        { id: 'message-1', phone_iccid: 'iccid-1', phone_number: 'sender-1' },
        { id: 'message-2', phone_iccid: 'iccid-1', phone_number: 'sender-2' },
        { id: 'message-3', phone_iccid: null, phone_number: 'sender-3' },
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
    const body = await response.json();

    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).not.toContain('JOIN device_view');
    expect(db.calls[1].sql).toContain('WHERE iccid IN (?)');
    expect(db.calls[1].params).toEqual(['iccid-1']);
    expect(body.data[0]).toMatchObject({
      display_phone_number: '+6512345678',
      phone_carrier: 'Singtel',
      phone_status: 'active',
      phone_sim_index: 1,
      phone_country: 'SG',
      mapped_number: null,
    });
    expect(body.data[2].display_phone_number).toBe('sender-3');
    expect(body.pagination.has_more).toBe(false);
    expect(body.pagination.next_offset).toBeNull();
  });

  test('returns a stable keyset cursor for every incremental backlog page', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `message-${String(index).padStart(3, '0')}`,
      phone_iccid: 'iccid-1',
      created_at: `2026-09-02 00:00:${String(index % 60).padStart(2, '0')}`,
    }));
    const db = dbStub({ messages });
    const since = '2026-09-01T23:00:00.000Z';
    const until = '2026-09-02T01:00:00.000Z';

    const response = await messagesHandler.list(
      listRequest(
        db,
        `?limit=100&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.calls[0].sql).toContain('m.created_at <= datetime(?)');
    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_cursor).toEqual({
      created_at: messages[99].created_at,
      id: messages[99].id,
    });
    expect(body.sync.server_time).toBe(until);
  });

  test('continues incremental pages strictly before the last delivered key', async () => {
    const db = dbStub();
    const beforeCreatedAt = '2026-09-02 00:00:10';
    const beforeId = 'message-100';

    const response = await messagesHandler.list(
      listRequest(
        db,
        `?since=2026-09-01T23%3A00%3A00.000Z&until=2026-09-02T01%3A00%3A00.000Z&before_created_at=${encodeURIComponent(beforeCreatedAt)}&before_id=${beforeId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(db.calls[0].sql).toContain('m.created_at < ?');
    expect(db.calls[0].sql).toContain('(m.created_at = ? AND m.id < ?)');
    expect(db.calls[0].params).toContain(beforeCreatedAt);
    expect(db.calls[0].params).toContain(beforeId);
  });

  test('chunks device enrichment below D1s 100-bound-parameter limit', async () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      id: `message-${index}`,
      phone_iccid: `iccid-${index}`,
    }));
    const db = dbStub({ messages });

    const response = await messagesHandler.list(listRequest(db, '?limit=205'));

    expect(response.status).toBe(200);
    const enrichmentCalls = db.calls.filter(({ sql }) => sql.includes('FROM device_view'));
    expect(enrichmentCalls).toHaveLength(3);
    expect(enrichmentCalls.every(({ params }) => params.length <= 100)).toBe(true);
  });
});

describe('message send', () => {
  function sendDb({ active = { number: '+6512345678' }, any = null, runError = null } = {}) {
    const inserts = [];
    const db = {
      inserts,
      prepare(sql) {
        const statement = (params = []) => ({
          bind: (...next) => statement(next),
          async first() {
            if (sql.includes("sim_status = 'active'")) return active;
            return any;
          },
          async run() {
            if (runError) throw runError;
            inserts.push({ sql, params });
            return { meta: { changes: 1, last_row_id: 1 } };
          },
        });
        return statement();
      },
    };
    return db;
  }

  function sendRequest(db, body) {
    return {
      env: { DB: db },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
  }

  const valid = { phone_iccid: 'iccid-1', recipient: '+6587654321', content: 'hello' };

  test('stores a sending message addressed to the normalised recipient', async () => {
    const db = sendDb();
    const response = await messagesHandler.send(sendRequest(db, valid));
    const body = await response.json();

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
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].params).toEqual([
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
      const response = await messagesHandler.send(sendRequest(sendDb(), bad));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/^Missing required fields/);
    }
  });

  test('answers 400 for a recipient that is not a phone number', async () => {
    const response = await messagesHandler.send(
      sendRequest(sendDb(), { ...valid, recipient: '+65123\r\nAT+CMGD=1' }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^Invalid recipient: /);
  });

  test('answers 400 when the SIM is unknown', async () => {
    const response = await messagesHandler.send(sendRequest(sendDb({ active: null }), valid));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Phone with ICCID 'iccid-1' not found in database");
  });

  test('answers 400 when the SIM is not active', async () => {
    const response = await messagesHandler.send(
      sendRequest(
        sendDb({ active: null, any: { iccid: 'iccid-1', sim_status: 'offline' } }),
        valid,
      ),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Phone found but status is 'offline' (not active)");
  });

  test('answers 500 when the message cannot be stored', async () => {
    const response = await messagesHandler.send(
      sendRequest(sendDb({ runError: new Error('D1 down') }), valid),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: 'Failed to send message' });
  });

  test('answers 400 for a body that is not JSON', async () => {
    const response = await messagesHandler.send(sendRequest(sendDb(), 'not json'));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^Missing required fields/);
  });

  test('answers 400 for fields that are not strings instead of sending their text', async () => {
    for (const bad of [
      { ...valid, content: { text: 'hi' } },
      { ...valid, phone_iccid: 8986 },
      { ...valid, recipient: 6587654321 },
    ]) {
      const db = sendDb();
      const response = await messagesHandler.send(sendRequest(db, bad));
      expect(response.status).toBe(400);
      expect(db.inserts).toHaveLength(0);
    }
  });
});

describe('outbound status changes reach the dashboard', () => {
  const since = '2026-09-02T00:00:00.000Z';

  test('an incremental sync carries an already-known row whose status moved', async () => {
    const db = dbStub({
      messages: [{ id: 'new-inbound', phone_iccid: 'iccid-1', content: 'code 1234' }],
      statusChanges: [
        {
          id: 'sent-earlier',
          phone_iccid: 'iccid-1',
          type: 'sent',
          status: 'sent',
          content: 'hello',
        },
      ],
    });

    const response = await messagesHandler.list(
      listRequest(db, `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`),
    );
    const body = await response.json();

    const refresh = db.calls.find((call) => call.sql.includes("m.type = 'sent'"));
    expect(refresh).toBeTruthy();
    expect(refresh.sql).toContain("m.updated_at >= datetime(?, '-2 seconds')");
    expect(refresh.sql).toContain('ORDER BY m.updated_at DESC');
    expect(refresh.params).toContain(since);
    expect(refresh.params).toContain('iccid-1');

    expect(body.data.map((message) => message.id)).toEqual(['new-inbound', 'sent-earlier']);
    expect(body.sync.status_refreshed).toBe(1);
  });

  test('a row already in the page is not sent twice', async () => {
    const row = { id: 'same-row', phone_iccid: 'iccid-1', type: 'sent', status: 'sent' };
    const db = dbStub({ messages: [row], statusChanges: [row] });

    const response = await messagesHandler.list(
      listRequest(db, `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`),
    );
    const body = await response.json();

    expect(body.data.map((message) => message.id)).toEqual(['same-row']);
    expect(body.sync.status_refreshed).toBe(0);
  });

  test('a full load does not run the refresh query', async () => {
    const db = dbStub({ messages: [], statusChanges: [{ id: 'x', type: 'sent' }] });

    await messagesHandler.list(listRequest(db, '?phone_iccid=iccid-1&limit=50'));

    expect(db.calls.some((call) => call.sql.includes("m.type = 'sent'"))).toBe(false);
  });
});
