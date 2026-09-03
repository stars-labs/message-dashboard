import { afterEach, describe, expect, test } from 'bun:test';
import { api } from './api.js';
import { auth } from './auth.js';
import { messageCache } from './message-cache.js';

const originalFetch = globalThis.fetch;
const originalBaseUrl = auth.baseUrl;
const originalCache = {
  getCachedMessages: messageCache.getCachedMessages,
  getLastSyncTime: messageCache.getLastSyncTime,
  setLastSyncTime: messageCache.setLastSyncTime,
  cacheMessages: messageCache.cacheMessages,
  pruneCache: messageCache.pruneCache,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  auth.baseUrl = originalBaseUrl;
  Object.assign(messageCache, originalCache);
});

function installCache({ lastSyncTime = null, fail = false } = {}) {
  const persisted = [];
  messageCache.getCachedMessages = async () => {
    if (fail) throw new Error('IndexedDB unavailable');
    return [];
  };
  messageCache.getLastSyncTime = async () => {
    if (fail) throw new Error('IndexedDB unavailable');
    return lastSyncTime;
  };
  messageCache.setLastSyncTime = async (_key, value) => {
    if (fail) throw new Error('IndexedDB unavailable');
    persisted.push(value);
  };
  messageCache.cacheMessages = async () => {};
  messageCache.pruneCache = async () => {};
  return persisted;
}

function installResponses(responses) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(String(url), 'https://example.com'));
    const body = responses.shift();
    if (!body) throw new Error('Unexpected request');
    return Response.json(body);
  };
  return urls;
}

function page({ data = [], serverTime, incremental = false, hasMore = false, nextCursor = null }) {
  return {
    success: true,
    data,
    pagination: { limit: 100, offset: 0, has_more: hasMore, next_cursor: nextCursor },
    sync: { server_time: serverTime, is_incremental: incremental },
  };
}

describe('message synchronization cursors', () => {
  test('keeps polling incrementally in memory when IndexedDB is unavailable', async () => {
    auth.baseUrl = 'https://example.com';
    installCache({ fail: true });
    const serverTime = '2026-09-02T01:00:00.000Z';
    const urls = installResponses([
      page({ serverTime }),
      page({ serverTime: '2026-09-02T01:01:00.000Z', incremental: true }),
    ]);

    await api.getMessages({ phone_iccid: 'memory-only', limit: 100 });
    await api.getMessages({ phone_iccid: 'memory-only', limit: 100 });

    expect(urls[0].searchParams.has('since')).toBe(false);
    expect(urls[1].searchParams.get('since')).toBe(serverTime);
  });

  test('uses an in-memory cursor for the uncached filtered audit view', async () => {
    auth.baseUrl = 'https://example.com';
    installCache();
    const serverTime = '2026-09-02T02:00:00.000Z';
    const urls = installResponses([
      page({ serverTime }),
      page({ serverTime: '2026-09-02T02:01:00.000Z', incremental: true }),
    ]);

    await api.getMessages({ phone_iccid: 'filtered-view', include_filtered: 1, limit: 100 });
    await api.getMessages({ phone_iccid: 'filtered-view', include_filtered: 1, limit: 100 });

    expect(urls[0].searchParams.has('since')).toBe(false);
    expect(urls[1].searchParams.get('since')).toBe(serverTime);
  });

  test('drains every incremental backlog page before advancing the cursor', async () => {
    auth.baseUrl = 'https://example.com';
    const persisted = installCache({ lastSyncTime: '2026-09-02T00:00:00.000Z' });
    const until = '2026-09-02T03:00:00.000Z';
    const firstMessages = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index}`,
      timestamp: '2026-09-02T02:30:00.000Z',
    }));
    const cursor = { created_at: '2026-09-02 02:00:00', id: 'message-99' };
    const urls = installResponses([
      page({ data: firstMessages, serverTime: until, incremental: true, hasMore: true, nextCursor: cursor }),
      page({
        data: [{ id: 'message-100', timestamp: '2026-09-02T01:30:00.000Z' }],
        serverTime: until,
        incremental: true,
      }),
    ]);

    const response = await api.getMessages({ phone_iccid: 'large-backlog', limit: 100 });

    expect(urls).toHaveLength(2);
    expect(urls[1].searchParams.get('until')).toBe(until);
    expect(urls[1].searchParams.get('before_created_at')).toBe(cursor.created_at);
    expect(urls[1].searchParams.get('before_id')).toBe(cursor.id);
    expect(response.sync.new_count).toBe(101);
    expect(persisted).toEqual([until]);
  });

  test('reset_sync reloads a filter scope fully and establishes a new cursor', async () => {
    auth.baseUrl = 'https://example.com';
    installCache();
    const firstTime = '2026-09-02T04:00:00.000Z';
    const resetTime = '2026-09-02T04:01:00.000Z';
    const urls = installResponses([
      page({ serverTime: firstTime }),
      page({ serverTime: resetTime }),
      page({ serverTime: '2026-09-02T04:02:00.000Z', incremental: true }),
    ]);

    const params = { phone_iccid: 'filter-reset', include_filtered: 1, limit: 100 };
    await api.getMessages(params);
    await api.getMessages({ ...params, reset_sync: 1 });
    await api.getMessages(params);

    expect(urls[1].searchParams.has('since')).toBe(false);
    expect(urls[1].searchParams.has('reset_sync')).toBe(false);
    expect(urls[2].searchParams.get('since')).toBe(resetTime);
  });
});
