import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ApiMessage } from '../../shared/api/messages.js';
import { messageCache } from './message-cache.js';

function message(id: string, phoneIccid: string | null, timestamp: string): ApiMessage {
  return {
    id,
    phone_iccid: phoneIccid,
    phone_number: null,
    content: id,
    timestamp,
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
  };
}

/** Writes a row straight into the store, bypassing the typed API, as an old client would have. */
async function storeRaw(row: object): Promise<void> {
  await messageCache.getCachedMessages();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('sms-dashboard-cache');
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(new Error('could not open the cache'));
    };
  });
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(['messages'], 'readwrite');
    transaction.objectStore('messages').put(row);
    transaction.oncomplete = () => {
      resolve();
    };
  });
  database.close();
}

beforeEach(async () => {
  await messageCache.clearCache();
});

describe('message cache', () => {
  test('returns every phone’s messages newest first, up to the limit', async () => {
    await messageCache.cacheMessages([
      message('old', 'sim-a', '2026-09-01T00:00:00.000Z'),
      message('new', 'sim-a', '2026-09-03T00:00:00.000Z'),
      message('mid', 'sim-a', '2026-09-02T00:00:00.000Z'),
      message('other', 'sim-b', '2026-09-04T00:00:00.000Z'),
    ]);

    const all = await messageCache.getCachedMessages();
    expect(all.map((m) => m.id)).toEqual(['other', 'new', 'mid', 'old']);

    const newest = await messageCache.getCachedMessages(null, 2);
    expect(newest.map((m) => m.id)).toEqual(['other', 'new']);
  });

  test('returns a phone’s newest messages when it has more than the limit', async () => {
    // Ids are random in production, so their order says nothing about age.
    await messageCache.cacheMessages([
      message('z-oldest', 'sim-a', '2026-09-01T00:00:00.000Z'),
      message('a-newest', 'sim-a', '2026-09-03T00:00:00.000Z'),
      message('m-middle', 'sim-a', '2026-09-02T00:00:00.000Z'),
    ]);

    const newest = await messageCache.getCachedMessages('sim-a', 2);

    expect(newest.map((m) => m.id)).toEqual(['a-newest', 'm-middle']);
  });

  test('returns only the requested phone’s messages', async () => {
    await messageCache.cacheMessages([
      message('a', 'sim-a', '2026-09-01T00:00:00.000Z'),
      message('b', 'sim-b', '2026-09-02T00:00:00.000Z'),
    ]);

    expect((await messageCache.getCachedMessages('sim-a')).map((m) => m.id)).toEqual(['a']);
  });

  test('skips a stored row that is not a message as the API returns it', async () => {
    await messageCache.cacheMessages([message('good', 'sim-a', '2026-09-01T00:00:00.000Z')]);
    await storeRaw({ id: 'stale', phone_iccid: 'sim-a', timestamp: '2026-09-02T00:00:00.000Z' });

    const cached = await messageCache.getCachedMessages('sim-a');

    expect(cached.map((m) => m.id)).toEqual(['good']);
  });

  test('remembers a sync time per key and forgets it on clear', async () => {
    expect(await messageCache.getLastSyncTime('sim-a')).toBeNull();

    await messageCache.setLastSyncTime('sim-a', '2026-09-02T00:00:00.000Z');
    expect(await messageCache.getLastSyncTime('sim-a')).toBe('2026-09-02T00:00:00.000Z');
    expect(await messageCache.getLastSyncTime('sim-b')).toBeNull();

    await messageCache.clearCache();
    expect(await messageCache.getLastSyncTime('sim-a')).toBeNull();
  });

  test('prunes each phone to its most recent messages', async () => {
    await messageCache.cacheMessages([
      message('a1', 'sim-a', '2026-09-01T00:00:00.000Z'),
      message('a2', 'sim-a', '2026-09-02T00:00:00.000Z'),
      message('a3', 'sim-a', '2026-09-03T00:00:00.000Z'),
      message('b1', 'sim-b', '2026-09-01T00:00:00.000Z'),
    ]);

    expect(await messageCache.pruneCache(2)).toBe(1);

    const all = await messageCache.getCachedMessages();
    expect(all.map((m) => m.id).sort()).toEqual(['a2', 'a3', 'b1']);
  });
});
