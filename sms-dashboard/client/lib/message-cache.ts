import * as v from 'valibot';
import { ApiMessage } from '../../shared/api/messages.js';

const DB_NAME = 'sms-dashboard-cache';
// Raise whenever a server change makes previously cached rows wrong (new columns,
// reclassified history, filter status); an upgrade clears the cache.
const DB_VERSION = 6;
const MESSAGES_STORE = 'messages';
const META_STORE = 'meta';

const SyncRecord = v.object({ key: v.string(), value: v.string() });

let db: IDBDatabase | null = null;

async function initDB(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[MessageCache] Failed to open IndexedDB:', request.error);
      reject(request.error ?? new Error('IndexedDB could not be opened'));
    };

    request.onsuccess = () => {
      db = request.result;
      console.debug('[MessageCache] IndexedDB initialized');
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = request.result;

      // The cache is a disposable copy, so an upgrade discards it instead of migrating rows.
      if (event.oldVersion > 0) {
        for (const name of [MESSAGES_STORE, META_STORE]) {
          if (database.objectStoreNames.contains(name)) {
            database.deleteObjectStore(name);
          }
        }
        console.debug(
          `[MessageCache] cleared cache upgrading v${String(event.oldVersion)} -> v${String(DB_VERSION)}`,
        );
      }

      if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
        const messagesStore = database.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
        messagesStore.createIndex('phone_iccid', 'phone_iccid', { unique: false });
        messagesStore.createIndex('timestamp', 'timestamp', { unique: false });
        messagesStore.createIndex('phone_timestamp', ['phone_iccid', 'timestamp'], {
          unique: false,
        });
      }

      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }

      console.debug('[MessageCache] IndexedDB schema created');
    };
  });
}

function timeOf(message: ApiMessage): number {
  return message.timestamp === null ? 0 : new Date(message.timestamp).getTime();
}

async function getLastSyncTime(phoneIccid = 'global'): Promise<string | null> {
  try {
    const database = await initDB();

    return await new Promise<string | null>((resolve) => {
      const transaction = database.transaction([META_STORE], 'readonly');
      const store = transaction.objectStore(META_STORE);
      const request = store.get(`lastSync_${phoneIccid}`);

      request.onsuccess = () => {
        const record = v.safeParse(SyncRecord, request.result);
        resolve(record.success && record.output.value !== '' ? record.output.value : null);
      };

      request.onerror = () => {
        console.warn('[MessageCache] Failed to get last sync time:', request.error);
        resolve(null);
      };
    });
  } catch (err) {
    console.warn('[MessageCache] getLastSyncTime error:', err);
    return null;
  }
}

async function setLastSyncTime(phoneIccid: string, timestamp: string): Promise<void> {
  try {
    const database = await initDB();

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([META_STORE], 'readwrite');
      const store = transaction.objectStore(META_STORE);
      const request = store.put({ key: `lastSync_${phoneIccid}`, value: timestamp });

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB write failed'));
      };
    });
  } catch (err) {
    console.warn('[MessageCache] setLastSyncTime error:', err);
  }
}

// A stored row that does not parse as an API message is skipped.
async function getCachedMessages(
  phoneIccid: string | null = null,
  limit = 500,
): Promise<ApiMessage[]> {
  try {
    const database = await initDB();

    return await new Promise<ApiMessage[]>((resolve) => {
      const transaction = database.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);

      const messages: ApiMessage[] = [];
      // Read through a time-ordered index: phone_iccid orders by random id, so a limited
      // read would return an arbitrary subset. [iccid] .. [iccid, []] spans every
      // timestamp of the phone because an array sorts after any string in key order.
      const request = phoneIccid
        ? store
            .index('phone_timestamp')
            .openCursor(IDBKeyRange.bound([phoneIccid], [phoneIccid, []]), 'prev')
        : store.index('timestamp').openCursor(null, 'prev');

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && messages.length < limit) {
          const message = v.safeParse(ApiMessage, cursor.value);
          if (message.success) messages.push(message.output);
          cursor.continue();
        } else {
          messages.sort((a, b) => timeOf(b) - timeOf(a));
          resolve(messages);
        }
      };

      request.onerror = () => {
        console.warn('[MessageCache] Failed to get cached messages:', request.error);
        resolve([]);
      };
    });
  } catch (err) {
    console.warn('[MessageCache] getCachedMessages error:', err);
    return [];
  }
}

async function cacheMessages(messages: readonly ApiMessage[]): Promise<void> {
  if (messages.length === 0) return;

  try {
    const database = await initDB();

    await new Promise<void>((resolve) => {
      const transaction = database.transaction([MESSAGES_STORE], 'readwrite');
      const store = transaction.objectStore(MESSAGES_STORE);

      let completed = 0;
      const total = messages.length;

      for (const msg of messages) {
        const request = store.put(msg);
        request.onsuccess = () => {
          completed++;
          if (completed === total) {
            console.debug(`[MessageCache] Cached ${String(total)} messages`);
            resolve();
          }
        };
        request.onerror = () => {
          console.warn('[MessageCache] Failed to cache message:', msg.id, request.error);
          completed++;
          if (completed === total) resolve();
        };
      }
    });
  } catch (err) {
    console.warn('[MessageCache] cacheMessages error:', err);
  }
}

async function clearCache(): Promise<void> {
  try {
    const database = await initDB();

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([MESSAGES_STORE, META_STORE], 'readwrite');

      transaction.objectStore(MESSAGES_STORE).clear();
      transaction.objectStore(META_STORE).clear();

      transaction.oncomplete = () => {
        console.debug('[MessageCache] Cache cleared');
        resolve();
      };

      transaction.onerror = () => {
        reject(transaction.error ?? new Error('IndexedDB clear failed'));
      };
    });
  } catch (err) {
    console.warn('[MessageCache] clearCache error:', err);
    throw err;
  }
}

function storedPhone(value: unknown): string {
  const row = v.safeParse(v.object({ phone_iccid: v.nullish(v.string()) }), value);
  return (row.success ? row.output.phone_iccid : null) ?? 'global';
}

async function pruneCache(maxMessagesPerPhone = 200): Promise<number> {
  try {
    const database = await initDB();

    const phones = new Set<string>();
    const readTransaction = database.transaction([MESSAGES_STORE], 'readonly');
    const readStore = readTransaction.objectStore(MESSAGES_STORE);

    await new Promise<void>((resolve) => {
      const request = readStore.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          phones.add(storedPhone(cursor.value));
          cursor.continue();
        } else {
          resolve();
        }
      };
    });

    let totalDeleted = 0;

    for (const phoneIccid of phones) {
      const messages = await getCachedMessages(phoneIccid, 10000);

      if (messages.length > maxMessagesPerPhone) {
        const toDelete = messages.slice(maxMessagesPerPhone);
        const writeTransaction = database.transaction([MESSAGES_STORE], 'readwrite');
        const writeStore = writeTransaction.objectStore(MESSAGES_STORE);

        for (const msg of toDelete) {
          writeStore.delete(msg.id);
          totalDeleted++;
        }

        await new Promise<void>((resolve) => {
          writeTransaction.oncomplete = () => {
            resolve();
          };
        });
      }
    }

    if (totalDeleted > 0) {
      console.debug(`[MessageCache] Pruned ${String(totalDeleted)} old messages`);
    }

    return totalDeleted;
  } catch (err) {
    console.warn('[MessageCache] pruneCache error:', err);
    return 0;
  }
}

export const messageCache = {
  getLastSyncTime,
  setLastSyncTime,
  getCachedMessages,
  cacheMessages,
  clearCache,
  pruneCache,
};
