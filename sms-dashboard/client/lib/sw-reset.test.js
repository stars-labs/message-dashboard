import { describe, expect, it, mock } from 'bun:test';
import { resetDashboardCache, resetServiceWorker } from './sw-reset.js';

/** Minimal stand-ins for the two browser APIs the reset touches. */
function fakeEnv({ registrations = 1, cacheKeys = ['workbox-precache-v2'], unregister, deleteCache } = {}) {
  const regs = Array.from({ length: registrations }, () => ({
    unregister: unregister ?? mock(async () => true),
  }));
  return {
    regs,
    navigator: { serviceWorker: { getRegistrations: async () => regs } },
    caches: { keys: async () => cacheKeys, delete: deleteCache ?? mock(async () => true) },
  };
}

describe('resetServiceWorker', () => {
  it('unregisters every registration and deletes every cache', async () => {
    const env = fakeEnv({ registrations: 2, cacheKeys: ['a', 'b', 'c'] });
    const result = await resetServiceWorker(env);
    expect(result.unregistered).toBe(2);
    expect(result.cachesDeleted).toBe(3);
    expect(result.ok).toBe(true);
    for (const r of env.regs) expect(r.unregister).toHaveBeenCalledTimes(1);
    expect(env.caches.delete).toHaveBeenCalledTimes(3);
  });

  it('succeeds when there is nothing installed', async () => {
    const env = fakeEnv({ registrations: 0, cacheKeys: [] });
    const result = await resetServiceWorker(env);
    expect(result).toEqual({ ok: true, unregistered: 0, cachesDeleted: 0 });
  });

  it('still clears caches when unregistering throws', async () => {
    // A half-reset is worse than either extreme: a live worker serving no cache is
    // recoverable, a dead worker with a stale cache is not. Caches must be cleared
    // even if unregister fails.
    const env = fakeEnv({
      unregister: mock(async () => { throw new Error('boom'); }),
      cacheKeys: ['stale'],
    });
    const result = await resetServiceWorker(env);
    expect(env.caches.delete).toHaveBeenCalledWith('stale');
    expect(result.ok).toBe(false);
    expect(result.cachesDeleted).toBe(1);
  });

  it('reports failure when cache deletion throws', async () => {
    const env = fakeEnv({ deleteCache: mock(async () => { throw new Error('nope'); }) });
    const result = await resetServiceWorker(env);
    expect(result.ok).toBe(false);
  });

  it('degrades cleanly where service workers are unsupported', async () => {
    const result = await resetServiceWorker({ navigator: {}, caches: undefined });
    expect(result).toEqual({ ok: true, unregistered: 0, cachesDeleted: 0 });
  });

  it('clears caches even when serviceWorker is missing but caches exist', async () => {
    const del = mock(async () => true);
    const result = await resetServiceWorker({
      navigator: {},
      caches: { keys: async () => ['x'], delete: del },
    });
    expect(del).toHaveBeenCalledWith('x');
    expect(result.cachesDeleted).toBe(1);
  });
});

describe('resetDashboardCache', () => {
  it('clears the IndexedDB message cache as well as offline caches', async () => {
    const clearMessageCache = mock(async () => {});
    const resetOfflineCache = mock(async () => ({ ok: true, unregistered: 1, cachesDeleted: 2 }));

    const result = await resetDashboardCache({ clearMessageCache, resetOfflineCache });

    expect(clearMessageCache).toHaveBeenCalledTimes(1);
    expect(resetOfflineCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, unregistered: 1, cachesDeleted: 2 });
  });

  it('reports failure but still attempts both independent cache clears', async () => {
    const clearMessageCache = mock(async () => { throw new Error('IndexedDB blocked'); });
    const resetOfflineCache = mock(async () => ({ ok: true, unregistered: 0, cachesDeleted: 1 }));

    const result = await resetDashboardCache({ clearMessageCache, resetOfflineCache });

    expect(resetOfflineCache).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.cachesDeleted).toBe(1);
  });
});
