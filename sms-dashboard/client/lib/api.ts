import { auth } from './auth';
import { messageCache } from './message-cache';
import type { PagedMessage } from './message-page';

// Runtime cursors keep polling cheap even when IndexedDB is unavailable or the
// current view deliberately avoids persistent caching (for example spam audit).
const volatileMessageCursors = new Map<string, string>();

/** The server's error body. `detail` is present for upstream failures. */
interface ApiErrorBody {
  error?: string;
  detail?: string;
}

/** A message row as the API returns it. */
export interface ApiMessage extends PagedMessage {
  timestamp: string;
  type?: string | null;
  content?: string | null;
  phone_iccid?: string | null;
  phone_number?: string | null;
  [column: string]: unknown;
}

/** The paging envelope /api/messages returns. */
export interface ApiMessagePagination {
  has_more?: boolean;
  next_cursor?: { created_at?: string; id?: string } | null;
  limit?: number;
  offset?: number;
  [column: string]: unknown;
}

export interface ApiMessageSync {
  server_time?: string;
  is_incremental?: boolean;
  from_cache?: number;
  new_count?: number;
  is_offline?: boolean;
  [column: string]: unknown;
}

/** The /api/messages response, before and after the client merges cache. */
export interface ApiMessagePage {
  success?: boolean;
  data?: ApiMessage[];
  pagination?: ApiMessagePagination;
  sync?: ApiMessageSync;
  failed?: boolean;
  [column: string]: unknown;
}

/** Parameters /api/messages accepts. */
export interface GetMessagesParams {
  phone_iccid?: string | null;
  limit?: number;
  include_filtered?: boolean | number | string;
  force_refresh?: boolean;
  reset_sync?: boolean;
  since?: string;
  until?: string;
  before_created_at?: string;
  before_id?: string;
  offset?: number;
  [column: string]: unknown;
}

/** A balance check row as /api/balance-checks returns it. */
export interface ApiBalanceCheck {
  id: string;
  [column: string]: unknown;
}

export async function fetchWithAuth(endpoint: string, options: RequestInit = {}): Promise<any> {
  const fullUrl = `${auth.baseUrl}${endpoint}`;

  // Credentials travel as the HttpOnly auth_token cookie, which the browser attaches
  // itself — there is no token for JavaScript to read or forward.
  // See docs/SECURITY-REVIEW.md finding 4.
  const response = await fetch(fullUrl, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (response.status === 401) {
    auth.logout();
    throw new Error('Authentication required');
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorData: ApiErrorBody;
    try {
      errorData = JSON.parse(errorText) as ApiErrorBody;
    } catch {
      errorData = { error: 'Unknown error' };
    }
    // Include `detail` when the server sends one. Without it an upstream failure
    // surfaced as a bare "Auth0 Management API request failed" with the actual cause
    // (missing scope, bad credentials, absent role) only visible in the Worker logs.
    const base = errorData.error || `Request failed with status ${response.status}`;
    throw new Error(errorData.detail ? `${base}: ${errorData.detail}` : base);
  }

  return await response.json();
}

type EndpointParams = Record<string, unknown>;

interface Endpoint {
  url: string | ((params: Record<string, string | number | undefined>) => string);
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
}

/** Route API method names to HTTP endpoints */
const httpEndpoints = {
    'getPhones': { url: '/api/phones', method: 'GET' },
    'getMessages': { url: '/api/messages', method: 'GET' },
    'getBalanceChecks': { url: '/api/balance-checks', method: 'GET' },
    'sendMessage': { url: '/api/messages/send', method: 'POST' },
    'getUser': { url: '/api/auth/me', method: 'GET' },
    'listIccidMappings': { url: '/api/iccid-mappings', method: 'GET' },
    'getIccidMapping': { url: (params) => `/api/iccid-mappings/${params.id}`, method: 'GET' },
    'getIccidMappingByIccid': { url: (params) => `/api/iccid-mappings/by-iccid/${params.iccid}`, method: 'GET' },
    'createIccidMapping': { url: '/api/iccid-mappings', method: 'POST' },
    'updateIccidMapping': { url: (params) => `/api/iccid-mappings/${params.id}`, method: 'PUT' },
    'deleteIccidMapping': { url: (params) => `/api/iccid-mappings/${params.id}`, method: 'DELETE' },
    'bulkImportIccidMappings': { url: '/api/iccid-mappings/bulk', method: 'POST' },
  } satisfies Record<string, Endpoint>;

/** A method name the endpoint table actually contains. */
type ApiMethod = keyof typeof httpEndpoints;

async function apiRequest(method: ApiMethod, data: EndpointParams = {}): Promise<any> {
  const endpoint: Endpoint = httpEndpoints[method];
  if (!endpoint) {
    throw new Error(`Unknown API method: ${method}`);
  }
  
  const url = typeof endpoint.url === 'function'
    ? endpoint.url(data as Record<string, string | number | undefined>)
    : endpoint.url;
  const options: RequestInit = {
    method: endpoint.method,
  };
  
  if (endpoint.method === 'GET' && data && Object.keys(data).length > 0) {
    // Add query params for GET requests
    const query = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    );
    const queryString = new URLSearchParams(query).toString();
    return fetchWithAuth(`${url}?${queryString}`, options);
  } else if (endpoint.method !== 'GET') {
    // Add body for non-GET requests
    options.body = JSON.stringify(data);
  }
  
  return fetchWithAuth(url, options);
}

export const api = {
  // Cache management
  cache: {
    async getStats() {
      return await messageCache.getCacheStats();
    },
    async clear() {
      return await messageCache.clearCache();
    },
    async prune(maxPerPhone = 200) {
      return await messageCache.pruneCache(maxPerPhone);
    }
  },

  // Generic HTTP methods for AI features
  async get(url: string, options: RequestInit = {}) {
    return await fetchWithAuth(url, { ...options, method: 'GET' });
  },
  
  async post(url: string, data: unknown = {}, options: RequestInit = {}) {
    return await fetchWithAuth(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(data)
    });
  },
  
  async put(url: string, data: unknown = {}, options: RequestInit = {}) {
    return await fetchWithAuth(url, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },
  
  async delete(url: string, options: RequestInit = {}) {
    return await fetchWithAuth(url, { ...options, method: 'DELETE' });
  },
  
  // Auth
  async getUser() {
    try {
      return await apiRequest('getUser');
    } catch {
      // Fallback to HTTP for auth (needed for initial login)
      return await fetchWithAuth('/api/auth/me');
    }
  },
  
  async logout() {
    auth.logout();
  },
  
  // No getAuthToken(): the session is an HttpOnly cookie that JavaScript cannot read,
  // and callers do not need it — fetch sends it automatically.
  // See docs/SECURITY-REVIEW.md finding 4.
  
  // Phones
  async getPhones() {
    try {
      const response = await apiRequest('getPhones');
      return response.success ? response.data : [];
    } catch (error) {
      console.warn('Failed to get phones:', error);
      // Return empty array instead of throwing
      return [];
    }
  },
  
  // Messages - with client-side caching for reduced D1 reads
  async getMessages(params: GetMessagesParams = {}): Promise<ApiMessagePage> {
    const phoneIccid = params.phone_iccid || null;
    const includeFiltered = params.include_filtered === true
      || params.include_filtered === 1
      || params.include_filtered === '1';
    const cacheKey = includeFiltered
      ? `filtered:${phoneIccid || 'global'}`
      : phoneIccid || 'global';
    const persistentCacheEnabled = !includeFiltered;
    const forceRefresh = params.force_refresh || false;
    const resetSync = params.reset_sync || false;

    try {
      // Step 1: Get cached messages first for immediate display
      let cachedMessages: ApiMessage[] = [];
      let lastSyncTime: string | null = null;

      if (!forceRefresh && persistentCacheEnabled) {
        try {
          cachedMessages = await messageCache.getCachedMessages(phoneIccid, params.limit || 500) as ApiMessage[];
          lastSyncTime = await messageCache.getLastSyncTime(cacheKey) as string | null;
        } catch (cacheErr) {
          console.warn('[API] Cache read failed:', cacheErr);
        }
      }
      if (!forceRefresh && !resetSync) {
        lastSyncTime = volatileMessageCursors.get(cacheKey) || lastSyncTime;
      } else if (resetSync) {
        lastSyncTime = null;
      }

      // Step 2: Fetch new messages from API (incremental if we have cache)
      const { force_refresh: _forceRefresh, reset_sync: _resetSync, ...apiParams } = params as GetMessagesParams;
      if (lastSyncTime && !forceRefresh) {
        apiParams.since = lastSyncTime;
        // Reduce limit for incremental sync since we're only getting new messages
        apiParams.limit = Math.min(params.limit || 100, 100);
      }

      let response = await apiRequest('getMessages', apiParams);

      if (response.success && response.sync?.is_incremental) {
        const syncUntil = response.sync.server_time;
        const collected: ApiMessage[] = [...(response.data || [])];
        while (response.pagination?.has_more === true) {
          const cursor = response.pagination?.next_cursor;
          if (!syncUntil || !cursor?.created_at || !cursor?.id) {
            throw new Error('Incremental message page is missing its stable cursor');
          }
          response = await apiRequest('getMessages', {
            ...apiParams,
            since: lastSyncTime ?? undefined,
            until: syncUntil,
            before_created_at: cursor.created_at,
            before_id: cursor.id,
            offset: 0,
          });
          if (!response.success || response.sync?.server_time !== syncUntil) {
            throw new Error('Incremental message page changed its synchronization window');
          }
          collected.push(...(response.data || []));
        }
        response = {
          ...response,
          data: collected,
          sync: {
            ...response.sync,
            server_time: syncUntil,
            is_incremental: true,
            new_count: collected.length,
          },
        };
      }

      if (response.success) {
        const newMessages: ApiMessage[] = response.data || [];
        const serverTime = response.sync?.server_time || new Date().toISOString();


        // Step 3: Cache new messages
        if (persistentCacheEnabled && newMessages.length > 0) {
          try {
            await messageCache.cacheMessages(newMessages);
            // Prune old messages to keep IndexedDB bounded
            messageCache.pruneCache(200).catch(() => {});
          } catch (cacheErr) {
            console.warn('[API] Cache write failed:', cacheErr);
          }
        }

        // Step 4: Advance only after every incremental page completed. Forced
        // history pagination must not move the live ingestion cursor.
        if (!forceRefresh) {
          volatileMessageCursors.set(cacheKey, serverTime);
          if (persistentCacheEnabled) {
            try {
              await messageCache.setLastSyncTime(cacheKey, serverTime);
            } catch (cacheErr) {
              console.warn('[API] Failed to update sync time:', cacheErr);
            }
          }
        }

        // Step 5: Merge new messages with cached.
        //
        // A server row always wins over the cached copy with the same id: an
        // incremental response now also carries outbound rows whose status
        // changed (已发送 / 发送失败), and dropping them as "duplicates" was why a
        // sent SMS stayed at 等待发送 for the life of the cache.
        if (response.sync?.is_incremental && cachedMessages.length > 0) {
          const existingIds = new Set(cachedMessages.map(m => m.id));
          const uniqueNewMessages = newMessages.filter(m => !existingIds.has(m.id));
          const freshById = new Map(newMessages.map(m => [m.id, m]));
          const merged = [
            ...uniqueNewMessages,
            ...cachedMessages.map(m => freshById.get(m.id) ?? m),
          ];
          // Sort by timestamp descending and limit
          merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          const limitedMerged = merged.slice(0, params.limit || 500);
          const requestedLimit = params.limit || 500;


          return {
            success: true,
            data: limitedMerged,
            pagination: {
              ...response.pagination,
              // An incremental response only describes newly ingested rows. A
              // full local page may still have older server pages behind it.
              has_more: response.pagination?.has_more === true
                || cachedMessages.length >= requestedLimit,
            },
            sync: { ...response.sync, from_cache: cachedMessages.length, new_count: uniqueNewMessages.length }
          };
        }

        if (response.sync?.is_incremental) {
          response.sync = { ...response.sync, new_count: newMessages.length };
        }

        // Full refresh - return API data directly
        return response;
      }

      // API failed - return cached data if available
      if (cachedMessages.length > 0) {
        return {
          success: true,
          data: cachedMessages,
          pagination: {
            limit: params.limit || 500,
            offset: 0,
            has_more: cachedMessages.length >= (params.limit || 500),
          },
          sync: { from_cache: cachedMessages.length, is_offline: true }
        };
      }

      // Nothing from the API and nothing cached: say so. Returning a bare empty
      // page here made an outage render as a healthy, quiet inbox.
      return { data: [], pagination: {}, failed: true };
    } catch (error) {
      console.warn('Failed to get messages:', error);

      // Try to return cached data on error
      try {
        const cachedMessages = await messageCache.getCachedMessages(phoneIccid, params.limit || 500) as ApiMessage[];
        if (cachedMessages.length > 0) {
          return {
            success: true,
            data: cachedMessages,
            pagination: {
              limit: params.limit || 500,
              offset: 0,
              has_more: cachedMessages.length >= (params.limit || 500),
            },
            sync: { from_cache: cachedMessages.length, is_offline: true }
          };
        }
      } catch (cacheErr) {
        console.warn('[API] Cache fallback failed:', cacheErr);
      }

      return { data: [], pagination: {}, failed: true };
    }
  },

  async getBalanceChecks(params: EndpointParams = {}): Promise<ApiBalanceCheck[]> {
    try {
      const response = await apiRequest('getBalanceChecks', params);
      return response?.success ? response.data || [] : [];
    } catch (error) {
      console.warn('Failed to get balance checks:', error);
      return [];
    }
  },
  
  async sendMessage(data: unknown) {
    try {
      return await apiRequest('sendMessage', data as EndpointParams);
    } catch (error) {
      console.warn('Failed to send message:', error);
      throw error;
    }
  },
  
  // ICCID Mappings
  iccidMappings: {
    async list(params: EndpointParams = {}) {
      try {
        return await apiRequest('listIccidMappings', params);
      } catch (error) {
        console.warn('Failed to list ICCID mappings :', error);
        const query = new URLSearchParams(params as Record<string, string>).toString();
        return await fetchWithAuth(`/api/iccid-mappings?${query}`);
      }
    },
    
    async get(id: string) {
      try {
        return await apiRequest('getIccidMapping', { id });
      } catch (error) {
        console.warn('Failed to get ICCID mapping :', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`);
      }
    },
    
    async getByIccid(iccid: string) {
      try {
        return await apiRequest('getIccidMappingByIccid', { iccid });
      } catch (error) {
        console.warn('Failed to get ICCID mapping by ICCID :', error);
        return await fetchWithAuth(`/api/iccid-mappings/by-iccid/${iccid}`);
      }
    },
    
    async create(data: unknown) {
      try {
        return await apiRequest('createIccidMapping', data as EndpointParams);
      } catch (error) {
        console.warn('Failed to create ICCID mapping :', error);
        return await fetchWithAuth('/api/iccid-mappings', {
          method: 'POST',
          body: JSON.stringify(data),
        });
      }
    },
    
    async update(id: string, data: Record<string, unknown>) {
      try {
        return await apiRequest('updateIccidMapping', { id, ...data } as EndpointParams);
      } catch (error) {
        console.warn('Failed to update ICCID mapping :', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        });
      }
    },
    
    async delete(id: string) {
      try {
        return await apiRequest('deleteIccidMapping', { id });
      } catch (error) {
        console.warn('Failed to delete ICCID mapping :', error);
        return await fetchWithAuth(`/api/iccid-mappings/${id}`, {
          method: 'DELETE',
        });
      }
    },
    
    async bulkImport(data: unknown) {
      try {
        return await apiRequest('bulkImportIccidMappings', data as EndpointParams);
      } catch (error) {
        console.warn('Failed to bulk import ICCID mappings :', error);
        return await fetchWithAuth('/api/iccid-mappings/bulk', {
          method: 'POST',
          body: JSON.stringify(data),
        });
      }
    }
  }
};

// Nothing to pick up from the URL any more: the login callback delivers the session as
// an HttpOnly cookie rather than a `?token=` parameter.
// See docs/SECURITY-REVIEW.md finding 4.
