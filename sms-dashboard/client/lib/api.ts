import * as v from 'valibot';
import { parseJson, readJson, type Schema } from '../../shared/parse-json.js';
import { textOr } from '../../shared/text.js';
import { ErrorResponse } from '../../shared/api/error.js';
import type { BalanceCheck } from '../../shared/api/balance-checks.js';
import type {
  CreateIccidMappingBody,
  UpdateIccidMappingBody,
} from '../../shared/api/iccid-mappings.js';
import type { ApiMessage, MessagePage } from '../../shared/api/messages.js';
import type { Phone } from '../../shared/api/phones.js';
import { auth } from './auth.js';
import { contractClient } from './contract-link.js';
import { messageCache } from './message-cache.js';

// Runtime cursors keep polling cheap even when IndexedDB is unavailable or the
// current view deliberately avoids persistent caching (for example spam audit).
const volatileMessageCursors = new Map<string, string>();

/**
 * The error body, read leniently: a proxy or crash can answer without one. Routes
 * on the contract answer RFC 9457 problems, which carry `title` instead of `error`.
 */
const ErrorBody = v.partial(v.object({ ...ErrorResponse.entries, title: v.string() }));

/** A request the server refused or answered in a shape this client does not know. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** What to show for a caught failure: its message, or `fallback` when it has none. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? textOr(error.message, fallback) : fallback;
}

type QueryValue = string | number | boolean;

/** Parameters /api/messages accepts, plus the two that steer the client cache. */
interface GetMessagesParams {
  phone_iccid?: string;
  limit?: number;
  include_filtered?: QueryValue;
  force_refresh?: QueryValue;
  reset_sync?: QueryValue;
  since?: string;
  until?: string;
  before_created_at?: string;
  before_id?: string;
  offset?: number;
}

/** How a messages result was assembled: the server's window, and what the cache added. */
interface MessageSync {
  server_time?: string;
  is_incremental?: boolean;
  status_refreshed?: number;
  new_count?: number;
  from_cache?: number;
  is_offline?: boolean;
}

/**
 * GET /api/messages as the client sees it: the server's page, possibly merged
 * with cached rows, or the cached rows alone while the server is unreachable.
 * `failed` means neither was available.
 */
type MessagesResult =
  | {
      success: true;
      data: ApiMessage[];
      pagination: Partial<MessagePage['pagination']>;
      sync: MessageSync;
    }
  | { data: []; pagination: Record<string, never>; failed: true };

async function send(endpoint: string, options: RequestInit): Promise<Response> {
  // Credentials travel as the HttpOnly auth_token cookie, which the browser attaches
  // itself — there is no token for JavaScript to read or forward.
  // See docs/SECURITY-REVIEW.md finding 4.
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return checked(
    await fetch(`${auth.baseUrl}${endpoint}`, {
      ...options,
      credentials: 'same-origin',
      headers,
    }),
  );
}

/** Sends a request the contract client built; a refusal or failure is an ApiError. */
async function sendContract(built: Request): Promise<Response> {
  return checked(await fetch(built, { credentials: 'same-origin' }));
}

/** The response when it succeeded; otherwise the ApiError it stands for. */
async function checked(response: Response): Promise<Response> {
  if (response.status === 401) {
    auth.logout();
    throw new ApiError('Authentication required', 401);
  }

  if (!response.ok) {
    const body = parseJson(await response.text(), ErrorBody);
    const errorBody = body.ok ? body.value : { error: 'Unknown error' };
    // Include `detail` when the server sends one. Without it an upstream failure
    // surfaced as a bare "Auth0 Management API request failed" with the actual cause
    // (missing scope, bad credentials, absent role) only visible in the Worker logs.
    const base = textOr(
      errorBody.error ?? errorBody.title,
      `Request failed with status ${String(response.status)}`,
    );
    const detail = textOr(errorBody.detail, null);
    throw new ApiError(detail === null ? base : `${base}: ${detail}`, response.status);
  }

  return response;
}

/**
 * The routes served through the contract, for a signed-in dashboard. Failures
 * arrive as ApiError, as with `request`, and a 401 signs the user out.
 */
export const contractApi = contractClient(() => auth.baseUrl, sendContract);

/** Query parameters as the URL carries them: text, and absent when undefined. */
function queryText(
  params: Readonly<Record<string, QueryValue | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
}

/** Sends a request and parses the answer with `schema`; a mismatch is an ApiError. */
export async function request<T>(
  endpoint: string,
  schema: Schema<T>,
  options: RequestInit = {},
): Promise<T> {
  const response = await send(endpoint, options);
  const parsed = await readJson(response, schema);
  if (!parsed.ok) {
    throw new ApiError(`Unexpected response from ${endpoint}: ${parsed.error}`, response.status);
  }
  return parsed.value;
}

/** A limit of 0 or none means the default. */
function positiveOr(value: number | undefined, fallback: number): number {
  return value === undefined || value === 0 ? fallback : value;
}

function isTrue(value: QueryValue | undefined): boolean {
  return value === true || value === 1 || value === '1';
}

function timeOf(message: ApiMessage): number {
  return message.timestamp === null ? 0 : new Date(message.timestamp).getTime();
}

function offlinePage(messages: ApiMessage[], limit: number): MessagesResult {
  return {
    success: true,
    data: messages,
    pagination: { limit, offset: 0, has_more: messages.length >= limit },
    sync: { from_cache: messages.length, is_offline: true },
  };
}

export const api = {
  // Cache management
  cache: {
    async clear() {
      await messageCache.clearCache();
    },
  },

  // No getAuthToken(): the session is an HttpOnly cookie that JavaScript cannot read,
  // and callers do not need it — fetch sends it automatically.
  // See docs/SECURITY-REVIEW.md finding 4.

  async getPhones(): Promise<Phone[]> {
    try {
      return (await contractApi.messages.phones()).data;
    } catch (error) {
      console.warn('Failed to get phones:', error);
      // Return empty array instead of throwing
      return [];
    }
  },

  // Messages - with client-side caching for reduced D1 reads
  async getMessages(params: GetMessagesParams = {}): Promise<MessagesResult> {
    const phoneIccid = textOr(params.phone_iccid, null);
    const includeFiltered = isTrue(params.include_filtered);
    const cacheKey = includeFiltered
      ? `filtered:${phoneIccid ?? 'global'}`
      : (phoneIccid ?? 'global');
    const persistentCacheEnabled = !includeFiltered;
    const forceRefresh = Boolean(params.force_refresh);
    const resetSync = Boolean(params.reset_sync);
    const limit = positiveOr(params.limit, 500);

    try {
      // Step 1: Get cached messages first for immediate display
      let cachedMessages: ApiMessage[] = [];
      let lastSyncTime: string | null = null;

      if (!forceRefresh && persistentCacheEnabled) {
        try {
          cachedMessages = await messageCache.getCachedMessages(phoneIccid, limit);
          lastSyncTime = await messageCache.getLastSyncTime(cacheKey);
        } catch (cacheErr) {
          console.warn('[API] Cache read failed:', cacheErr);
        }
      }
      if (!forceRefresh && !resetSync) {
        lastSyncTime = volatileMessageCursors.get(cacheKey) ?? lastSyncTime;
      } else if (resetSync) {
        lastSyncTime = null;
      }

      // Step 2: Fetch new messages from API (incremental if we have cache)
      const { force_refresh: _forceRefresh, reset_sync: _resetSync, ...apiParams } = params;
      if (lastSyncTime && !forceRefresh) {
        apiParams.since = lastSyncTime;
        // Reduce limit for incremental sync since we're only getting new messages
        apiParams.limit = Math.min(positiveOr(params.limit, 100), 100);
      }

      let response = await contractApi.messages.list({ query: queryText(apiParams) });

      if (response.sync.is_incremental) {
        const syncUntil = response.sync.server_time;
        const collected: ApiMessage[] = [...response.data];
        while (response.pagination.has_more) {
          const cursor = response.pagination.next_cursor;
          if (!cursor?.created_at || !cursor.id) {
            throw new Error('Incremental message page is missing its stable cursor');
          }
          response = await contractApi.messages.list({
            query: queryText({
              ...apiParams,
              since: lastSyncTime ?? undefined,
              until: syncUntil,
              before_created_at: cursor.created_at,
              before_id: cursor.id,
              offset: 0,
            }),
          });
          if (response.sync.server_time !== syncUntil) {
            throw new Error('Incremental message page changed its synchronization window');
          }
          collected.push(...response.data);
        }
        response = {
          ...response,
          data: collected,
          sync: { ...response.sync, server_time: syncUntil, is_incremental: true },
        };
      }

      const newMessages = response.data;
      const serverTime = response.sync.server_time;

      // Step 3: Cache new messages
      if (persistentCacheEnabled && newMessages.length > 0) {
        try {
          await messageCache.cacheMessages(newMessages);
          // Prune old messages to keep IndexedDB bounded
          messageCache.pruneCache(200).catch(() => undefined);
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
      if (response.sync.is_incremental && cachedMessages.length > 0) {
        const existingIds = new Set(cachedMessages.map((m) => m.id));
        const uniqueNewMessages = newMessages.filter((m) => !existingIds.has(m.id));
        const freshById = new Map(newMessages.map((m) => [m.id, m]));
        const merged = [
          ...uniqueNewMessages,
          ...cachedMessages.map((m) => freshById.get(m.id) ?? m),
        ];
        // Sort by timestamp descending and limit
        merged.sort((a, b) => timeOf(b) - timeOf(a));

        return {
          success: true,
          data: merged.slice(0, limit),
          pagination: {
            ...response.pagination,
            // An incremental response only describes newly ingested rows. A
            // full local page may still have older server pages behind it.
            has_more: response.pagination.has_more || cachedMessages.length >= limit,
          },
          sync: {
            ...response.sync,
            from_cache: cachedMessages.length,
            new_count: uniqueNewMessages.length,
          },
        };
      }

      // Full refresh - return API data directly
      return {
        success: true,
        data: response.data,
        pagination: response.pagination,
        sync: response.sync.is_incremental
          ? { ...response.sync, new_count: newMessages.length }
          : response.sync,
      };
    } catch (error) {
      console.warn('Failed to get messages:', error);

      // Try to return cached data on error
      try {
        const cachedMessages = await messageCache.getCachedMessages(phoneIccid, limit);
        if (cachedMessages.length > 0) return offlinePage(cachedMessages, limit);
      } catch (cacheErr) {
        console.warn('[API] Cache fallback failed:', cacheErr);
      }

      // Nothing from the API and nothing cached: say so. Returning a bare empty
      // page here made an outage render as a healthy, quiet inbox.
      return { data: [], pagination: {}, failed: true };
    }
  },

  async getBalanceChecks(
    params: Readonly<Record<string, QueryValue | undefined>> = {},
  ): Promise<BalanceCheck[]> {
    try {
      return (await contractApi.balanceChecks.list({ query: queryText(params) })).data;
    } catch (error) {
      console.warn('Failed to get balance checks:', error);
      return [];
    }
  },

  async sendMessage(data: { phone_iccid: string; recipient: string; content: string }) {
    try {
      return await contractApi.messages.send(data);
    } catch (error) {
      console.warn('Failed to send message:', error);
      throw error;
    }
  },

  // ICCID Mappings
  iccidMappings: {
    async list(params: Readonly<Record<string, QueryValue | undefined>> = {}) {
      return await contractApi.iccidMappings.list({ query: queryText(params) });
    },

    /** The saved SIM; the status says only whether it was new. */
    async create(data: v.InferInput<typeof CreateIccidMappingBody>) {
      return (await contractApi.iccidMappings.create(data)).body;
    },

    async update(id: string, data: v.InferInput<typeof UpdateIccidMappingBody>) {
      return await contractApi.iccidMappings.update({ params: { id }, body: data });
    },

    async delete(id: string) {
      return await contractApi.iccidMappings.remove({ params: { id } });
    },
  },
};

// Nothing to pick up from the URL any more: the login callback delivers the session as
// an HttpOnly cookie rather than a `?token=` parameter.
// See docs/SECURITY-REVIEW.md finding 4.
