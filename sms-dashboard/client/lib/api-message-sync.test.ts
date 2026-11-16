import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ApiMessage, MessagePage } from '../../shared/api/messages.js';
import { api } from './api.js';
import { auth } from './auth.js';
import { messageCache } from './message-cache.js';

const originalBaseUrl = auth.baseUrl;
const originalCache = { ...messageCache };
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
  Object.assign(messageCache, originalCache);
});

function message(overrides: Partial<ApiMessage> & { id: string }): ApiMessage {
  return {
    phone_iccid: null,
    phone_number: null,
    content: '',
    timestamp: '2026-09-02T00:00:00.000Z',
    type: 'received',
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
    display_phone_number: null,
    phone_carrier: null,
    phone_status: null,
    phone_sim_index: null,
    phone_country: null,
    mapped_number: null,
    ...overrides,
  };
}

function installCache({
  lastSyncTime = null,
  fail = false,
  cached = [],
}: { lastSyncTime?: string | null; fail?: boolean; cached?: ApiMessage[] } = {}) {
  const persisted: string[] = [];
  const unavailable = () => Promise.reject(new Error('IndexedDB unavailable'));
  messageCache.getCachedMessages = () => (fail ? unavailable() : Promise.resolve(cached));
  messageCache.getLastSyncTime = () => (fail ? unavailable() : Promise.resolve(lastSyncTime));
  messageCache.setLastSyncTime = (_key, value) => {
    if (fail) return unavailable();
    persisted.push(value);
    return Promise.resolve();
  };
  messageCache.cacheMessages = () => Promise.resolve();
  messageCache.pruneCache = () => Promise.resolve(0);
  return persisted;
}

function installResponses(responses: unknown[]) {
  const urls: URL[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (url: string | URL | Request) => {
        urls.push(new URL(url instanceof Request ? url.url : url, 'https://example.com'));
        const body = responses.shift();
        return body === undefined
          ? Promise.reject(new Error('Unexpected request'))
          : Promise.resolve(Response.json(body));
      },
      { preconnect: () => undefined },
    ),
  );
  return urls;
}

function page({
  data = [],
  serverTime,
  incremental = false,
  hasMore = false,
  nextCursor = null,
}: {
  data?: ApiMessage[];
  serverTime: string;
  incremental?: boolean;
  hasMore?: boolean;
  nextCursor?: MessagePage['pagination']['next_cursor'];
}): MessagePage {
  return {
    success: true,
    data,
    pagination: {
      include_filtered: false,
      limit: 100,
      offset: 0,
      has_more: hasMore,
      next_offset: null,
      next_cursor: nextCursor,
    },
    sync: { server_time: serverTime, is_incremental: incremental, status_refreshed: 0 },
  };
}

function sinceOf(url: URL | undefined): string | null {
  return url?.searchParams.get('since') ?? null;
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

    expect(sinceOf(urls[0])).toBeNull();
    expect(sinceOf(urls[1])).toBe(serverTime);
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

    expect(sinceOf(urls[0])).toBeNull();
    expect(sinceOf(urls[1])).toBe(serverTime);
  });

  test('drains every incremental backlog page before advancing the cursor', async () => {
    auth.baseUrl = 'https://example.com';
    const persisted = installCache({ lastSyncTime: '2026-09-02T00:00:00.000Z' });
    const until = '2026-09-02T03:00:00.000Z';
    const firstMessages = Array.from({ length: 100 }, (_, index) =>
      message({ id: `message-${String(index)}`, timestamp: '2026-09-02T02:30:00.000Z' }),
    );
    const cursor = { created_at: '2026-09-02 02:00:00', id: 'message-99' };
    const urls = installResponses([
      page({
        data: firstMessages,
        serverTime: until,
        incremental: true,
        hasMore: true,
        nextCursor: cursor,
      }),
      page({
        data: [message({ id: 'message-100', timestamp: '2026-09-02T01:30:00.000Z' })],
        serverTime: until,
        incremental: true,
      }),
    ]);

    const response = await api.getMessages({ phone_iccid: 'large-backlog', limit: 100 });

    expect(urls).toHaveLength(2);
    expect(urls[1]?.searchParams.get('until')).toBe(until);
    expect(urls[1]?.searchParams.get('before_created_at')).toBe(cursor.created_at);
    expect(urls[1]?.searchParams.get('before_id')).toBe(cursor.id);
    expect('sync' in response ? response.sync.new_count : null).toBe(101);
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

    expect(sinceOf(urls[1])).toBeNull();
    expect(urls[1]?.searchParams.has('reset_sync')).toBe(false);
    expect(sinceOf(urls[2])).toBe(resetTime);
  });
});

describe('outbound status updates', () => {
  test('a refreshed row replaces the cached copy instead of being dropped as a duplicate', async () => {
    auth.baseUrl = 'https://example.com';
    const sent = message({
      id: 'outbound-1',
      type: 'sent',
      status: 'sending',
      timestamp: '2026-09-02T03:00:00.000Z',
      content: 'hello',
    });
    installCache({ lastSyncTime: '2026-09-02T03:00:00.000Z', cached: [sent] });
    installResponses([
      page({
        data: [{ ...sent, status: 'sent' }],
        serverTime: '2026-09-02T03:05:00.000Z',
        incremental: true,
      }),
    ]);

    const result = await api.getMessages({ phone_iccid: 'iccid-1', limit: 100 });

    const row = result.data.find((m) => m.id === 'outbound-1');
    // 等待发送 → 已发送 must survive the merge; dropping it as a duplicate was
    // why a sent SMS never changed state.
    expect(row?.status).toBe('sent');
    expect(result.data).toHaveLength(1);
  });
});

describe('when the server is unreachable', () => {
  test('serves the cached rows as an offline page', async () => {
    auth.baseUrl = 'https://example.com';
    installCache({ cached: [message({ id: 'cached-1' })] });
    installResponses([]);

    const result = await api.getMessages({ limit: 100 });

    expect(result).toEqual({
      success: true,
      data: [message({ id: 'cached-1' })],
      pagination: { limit: 100, offset: 0, has_more: false },
      sync: { from_cache: 1, is_offline: true },
    });
  });

  test('says it failed when nothing is cached either', async () => {
    auth.baseUrl = 'https://example.com';
    installCache();
    installResponses([]);

    expect(await api.getMessages({ limit: 100 })).toEqual({
      data: [],
      pagination: {},
      failed: true,
    });
  });

  test('treats a page that does not match the contract as unreachable', async () => {
    auth.baseUrl = 'https://example.com';
    installCache();
    installResponses([{ success: true, data: [{ id: 'no-other-fields' }] }]);

    expect(await api.getMessages({ limit: 100 })).toEqual({
      data: [],
      pagination: {},
      failed: true,
    });
  });
});
