/**
 * Service worker kill switch.
 *
 * A service worker that ships broken is uniquely hard to recover from: reverting the
 * code does not uninstall it from devices that already have it, and the user cannot
 * clear it from iOS Safari's UI in any discoverable way. This gives support a
 * concrete instruction to hand out ("open 更多 and tap 重置离线缓存") instead of
 * "delete the app and re-add it".
 *
 * Injected environment rather than reaching for globals, so the ordering and the
 * failure handling are testable without a browser.
 */
export async function resetServiceWorker(env = globalThis) {
  const { navigator, caches } = env;
  let ok = true;
  let unregistered = 0;
  let cachesDeleted = 0;

  // Unregister first so a reload cannot re-populate the caches we are about to drop.
  if (navigator?.serviceWorker?.getRegistrations) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        await reg.unregister();
        unregistered += 1;
      }
    } catch {
      // Keep going: clearing the caches still helps, and stopping here would leave
      // the worse of the two states (worker gone in spirit, stale cache intact).
      ok = false;
    }
  }

  if (caches?.keys) {
    try {
      const keys = await caches.keys();
      for (const key of keys) {
        await caches.delete(key);
        cachesDeleted += 1;
      }
    } catch {
      ok = false;
    }
  }

  return { ok, unregistered, cachesDeleted };
}

/**
 * Clear both persistent message data (IndexedDB) and offline application caches.
 * The operations are independent so one failure never prevents the other cleanup.
 */
export async function resetDashboardCache({ clearMessageCache, resetOfflineCache }) {
  const [messageResult, offlineResult] = await Promise.allSettled([
    clearMessageCache(),
    resetOfflineCache(),
  ]);
  const offline = offlineResult.status === 'fulfilled'
    ? offlineResult.value
    : { ok: false, unregistered: 0, cachesDeleted: 0 };

  return {
    ...offline,
    ok: messageResult.status === 'fulfilled' && offline.ok,
  };
}
