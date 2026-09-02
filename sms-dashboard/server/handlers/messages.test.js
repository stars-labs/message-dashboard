import { describe, expect, test } from 'bun:test';
import { messagesHandler } from './messages.js';

function dbStub({ messages = [], count = { visible: 0, filtered: 0 } } = {}) {
  const calls = [];

  function statement(sql, params = []) {
    return {
      bind(...nextParams) {
        return statement(sql, nextParams);
      },
      async all() {
        calls.push({ operation: 'all', sql, params });
        return { results: messages };
      },
      async first() {
        calls.push({ operation: 'first', sql, params });
        return count;
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
  test('incremental sync bounds the list by ingestion time and skips the full count', async () => {
    const db = dbStub({ messages: [{
      id: 'message-1',
      phone_iccid: 'iccid-1',
      content: 'test',
    }] });
    const since = '2026-09-02T00:00:00.000Z';

    const response = await messagesHandler.list(listRequest(
      db,
      `?phone_iccid=iccid-1&limit=50&since=${encodeURIComponent(since)}`,
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].operation).toBe('all');
    expect(db.calls[0].sql).toContain("m.created_at >= datetime(?, '-2 seconds')");
    expect(db.calls[0].sql).toContain('ORDER BY m.created_at DESC, m.id DESC');
    expect(db.calls[0].params).toContain(since);
    expect(body.sync.is_incremental).toBe(true);
    expect(new Date(body.sync.server_time).toString()).not.toBe('Invalid Date');
    expect(body.pagination).not.toHaveProperty('total');
    expect(body.pagination).not.toHaveProperty('filtered_count');
  });

  test('full sync retains the exact inbox and filtered counts', async () => {
    const db = dbStub({
      messages: [{ id: 'message-1' }],
      count: { visible: 7, filtered: 3 },
    });

    const response = await messagesHandler.list(listRequest(db, '?limit=50'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.calls.map((call) => call.operation).sort()).toEqual(['all', 'first']);
    expect(body.pagination.total).toBe(7);
    expect(body.pagination.filtered_count).toBe(3);
    expect(body.sync.is_incremental).toBe(false);
  });
});
