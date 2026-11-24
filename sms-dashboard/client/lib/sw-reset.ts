// Kill switch: reverting code does not uninstall a broken worker from devices that have it,
// and iOS Safari offers no discoverable way to clear it.
interface SwResetEnv {
  navigator?: {
    serviceWorker?: { getRegistrations(): Promise<{ unregister(): Promise<boolean> }[]> };
  };
  caches?: {
    keys(): Promise<string[]>;
    delete(key: string): Promise<boolean>;
  };
}

interface SwResetResult {
  ok: boolean;
  unregistered: number;
  cachesDeleted: number;
}

export async function resetServiceWorker(
  env: SwResetEnv | typeof globalThis = globalThis,
): Promise<SwResetResult> {
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
      // Keep going: clearing the caches still helps.
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

// The two cleanups are independent: one failing must not skip the other.
export async function resetDashboardCache({
  clearMessageCache,
  resetOfflineCache,
}: {
  clearMessageCache: () => Promise<unknown>;
  resetOfflineCache: () => Promise<SwResetResult>;
}): Promise<SwResetResult> {
  const [messageResult, offlineResult] = await Promise.allSettled([
    clearMessageCache(),
    resetOfflineCache(),
  ]);
  const offline =
    offlineResult.status === 'fulfilled'
      ? offlineResult.value
      : { ok: false, unregistered: 0, cachesDeleted: 0 };

  return {
    ...offline,
    ok: messageResult.status === 'fulfilled' && offline.ok,
  };
}
