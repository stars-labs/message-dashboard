import type { KV } from '../server/lib/kv.js';

/** A KV namespace held in a Map; expirationTtl is accepted and ignored. */
export function memoryKv(
  initial: Record<string, string> = {},
): KV & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}
