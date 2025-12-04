/**
 * Message Cache Service using IndexedDB
 * Reduces D1 database reads by caching messages client-side
 * and only fetching new messages since last sync
 */

const DB_NAME = 'sms-dashboard-cache';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const META_STORE = 'meta';

let db = null;

/**
 * Initialize IndexedDB
 */
async function initDB() {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[MessageCache] Failed to open IndexedDB:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      console.debug('[MessageCache] IndexedDB initialized');
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Messages store with indexes
      if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
        const messagesStore = database.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
        messagesStore.createIndex('phone_iccid', 'phone_iccid', { unique: false });
        messagesStore.createIndex('timestamp', 'timestamp', { unique: false });
        messagesStore.createIndex('phone_timestamp', ['phone_iccid', 'timestamp'], { unique: false });
      }

      // Meta store for sync timestamps
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }

      console.debug('[MessageCache] IndexedDB schema created');
    };
  });
}

/**
 * Get last sync timestamp for a phone (or global)
 */
async function getLastSyncTime(phoneIccid = 'global') {
  try {
    await initDB();

    return new Promise((resolve) => {
      const transaction = db.transaction([META_STORE], 'readonly');
      const store = transaction.objectStore(META_STORE);
      const request = store.get(`lastSync_${phoneIccid}`);

      request.onsuccess = () => {
        resolve(request.result?.value || null);
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

/**
 * Set last sync timestamp
 */
async function setLastSyncTime(phoneIccid = 'global', timestamp) {
  try {
    await initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([META_STORE], 'readwrite');
      const store = transaction.objectStore(META_STORE);
      const request = store.put({ key: `lastSync_${phoneIccid}`, value: timestamp });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('[MessageCache] setLastSyncTime error:', err);
  }
}

/**
 * Get cached messages for a phone (or all)
 */
async function getCachedMessages(phoneIccid = null, limit = 500) {
  try {
    await initDB();

    return new Promise((resolve) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);

      const messages = [];
      let request;

      if (phoneIccid) {
        // Get messages for specific phone, sorted by timestamp desc
        const index = store.index('phone_iccid');
        request = index.openCursor(IDBKeyRange.only(phoneIccid), 'prev');
      } else {
        // Get all messages, sorted by timestamp desc
        const index = store.index('timestamp');
        request = index.openCursor(null, 'prev');
      }

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && messages.length < limit) {
          messages.push(cursor.value);
          cursor.continue();
        } else {
          // Sort by timestamp descending
          messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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

/**
 * Cache messages
 */
async function cacheMessages(messages) {
  if (!messages || messages.length === 0) return;

  try {
    await initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readwrite');
      const store = transaction.objectStore(MESSAGES_STORE);

      let completed = 0;
      const total = messages.length;

      messages.forEach(msg => {
        const request = store.put(msg);
        request.onsuccess = () => {
          completed++;
          if (completed === total) {
            console.debug(`[MessageCache] Cached ${total} messages`);
            resolve();
          }
        };
        request.onerror = () => {
          console.warn('[MessageCache] Failed to cache message:', msg.id, request.error);
          completed++;
          if (completed === total) resolve();
        };
      });

      if (total === 0) resolve();
    });
  } catch (err) {
    console.warn('[MessageCache] cacheMessages error:', err);
  }
}

/**
 * Get cache statistics
 */
async function getCacheStats() {
  try {
    await initDB();

    return new Promise((resolve) => {
      const transaction = db.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);
      const countRequest = store.count();

      countRequest.onsuccess = () => {
        resolve({
          messageCount: countRequest.result,
          dbName: DB_NAME
        });
      };

      countRequest.onerror = () => {
        resolve({ messageCount: 0, dbName: DB_NAME });
      };
    });
  } catch (err) {
    return { messageCount: 0, dbName: DB_NAME, error: err.message };
  }
}

/**
 * Clear all cached data
 */
async function clearCache() {
  try {
    await initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([MESSAGES_STORE, META_STORE], 'readwrite');

      transaction.objectStore(MESSAGES_STORE).clear();
      transaction.objectStore(META_STORE).clear();

      transaction.oncomplete = () => {
        console.debug('[MessageCache] Cache cleared');
        resolve();
      };

      transaction.onerror = () => reject(transaction.error);
    });
  } catch (err) {
    console.warn('[MessageCache] clearCache error:', err);
  }
}

/**
 * Delete old messages to keep cache size manageable
 * Keeps only the most recent N messages per phone
 */
async function pruneCache(maxMessagesPerPhone = 200) {
  try {
    await initDB();

    // Get all unique phone ICCIDs
    const phones = new Set();
    const transaction1 = db.transaction([MESSAGES_STORE], 'readonly');
    const store1 = transaction1.objectStore(MESSAGES_STORE);

    await new Promise((resolve) => {
      const request = store1.openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          phones.add(cursor.value.phone_iccid);
          cursor.continue();
        } else {
          resolve();
        }
      };
    });

    // For each phone, keep only the most recent messages
    let totalDeleted = 0;

    for (const phoneIccid of phones) {
      const messages = await getCachedMessages(phoneIccid, 10000); // Get all

      if (messages.length > maxMessagesPerPhone) {
        const toDelete = messages.slice(maxMessagesPerPhone);
        const transaction2 = db.transaction([MESSAGES_STORE], 'readwrite');
        const store2 = transaction2.objectStore(MESSAGES_STORE);

        for (const msg of toDelete) {
          store2.delete(msg.id);
          totalDeleted++;
        }

        await new Promise((resolve) => {
          transaction2.oncomplete = resolve;
        });
      }
    }

    if (totalDeleted > 0) {
      console.debug(`[MessageCache] Pruned ${totalDeleted} old messages`);
    }

    return totalDeleted;
  } catch (err) {
    console.warn('[MessageCache] pruneCache error:', err);
    return 0;
  }
}

export const messageCache = {
  initDB,
  getLastSyncTime,
  setLastSyncTime,
  getCachedMessages,
  cacheMessages,
  getCacheStats,
  clearCache,
  pruneCache
};
