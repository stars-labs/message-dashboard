import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
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

// Keeps polling incremental when IndexedDB is unavailable or the view skips the persistent cache.
const volatileMessageCursors = new Map<string, string>();

// Lenient: a proxy or crash can answer without a body. Contract routes answer RFC 9457
// problems, which carry `title` instead of `error`.
const ErrorBody = v.partial(v.object({ ...ErrorResponse.entries, title: v.string() }));

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? textOr(error.message, fallback) : fallback;
}

type QueryValue = string | number | boolean;

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

interface MessageSync {
  server_time?: string;
  is_incremental?: boolean;
  status_refreshed?: number;
  new_count?: number;
  from_cache?: number;
  is_offline?: boolean;
}

// `failed` means neither the server nor the cache had anything.
type MessagesResult =
  | {
      success: true;
      data: ApiMessage[];
      pagination: Partial<MessagePage['pagination']>;
      sync: MessageSync;
    }
  | { data: []; pagination: Record<string, never>; failed: true };

async function send(built: Request): Promise<Response> {
  // Auth is the HttpOnly auth_token cookie; JavaScript never sees a token.
  return checked(await fetch(built, { credentials: 'same-origin' }));
}

async function checked(response: Response): Promise<Response> {
  if (response.status === 401) {
    auth.logout();
    throw new ApiError('Authentication required', 401);
  }

  if (!response.ok) {
    const body = parseJson(await response.text(), ErrorBody);
    const errorBody = body.ok ? body.value : { error: 'Unknown error' };
    // `detail` carries the upstream cause (missing scope, bad credentials) that is otherwise only in Worker logs.
    const base = textOr(
      errorBody.error ?? errorBody.title,
      `Request failed with status ${String(response.status)}`,
    );
    const detail = textOr(errorBody.detail, null);
    throw new ApiError(detail === null ? base : `${base}: ${detail}`, response.status);
  }

  return response;
}

export const contractApi = contractClient(() => auth.baseUrl, send);

function queryText(
  params: Readonly<Record<string, QueryValue | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
}

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
  cache: {
    async clear() {
      await messageCache.clearCache();
    },
  },

  async getPhones(): Promise<Phone[]> {
    try {
      return (await contractApi.messages.phones()).data;
    } catch (error) {
      console.warn('Failed to get phones:', error);
      return [];
    }
  },

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

      const { force_refresh: _forceRefresh, reset_sync: _resetSync, ...apiParams } = params;
      if (lastSyncTime && !forceRefresh) {
        apiParams.since = lastSyncTime;
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

      if (persistentCacheEnabled && newMessages.length > 0) {
        try {
          await messageCache.cacheMessages(newMessages);
          messageCache.pruneCache(200).catch(() => undefined);
        } catch (cacheErr) {
          console.warn('[API] Cache write failed:', cacheErr);
        }
      }

      // Forced history pagination must not move the live ingestion cursor.
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

      // A server row wins over the cached copy with the same id: incremental
      // responses also carry outbound rows whose status changed.
      if (response.sync.is_incremental && cachedMessages.length > 0) {
        const existingIds = new Set(cachedMessages.map((m) => m.id));
        const uniqueNewMessages = newMessages.filter((m) => !existingIds.has(m.id));
        const freshById = new Map(newMessages.map((m) => [m.id, m]));
        const merged = [
          ...uniqueNewMessages,
          ...cachedMessages.map((m) => freshById.get(m.id) ?? m),
        ];
        merged.sort((a, b) => timeOf(b) - timeOf(a));

        return {
          success: true,
          data: merged.slice(0, limit),
          pagination: {
            ...response.pagination,
            // An incremental response covers only new rows; a full local page may have older server pages behind it.
            has_more: response.pagination.has_more || cachedMessages.length >= limit,
          },
          sync: {
            ...response.sync,
            from_cache: cachedMessages.length,
            new_count: uniqueNewMessages.length,
          },
        };
      }

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

      try {
        const cachedMessages = await messageCache.getCachedMessages(phoneIccid, limit);
        if (cachedMessages.length > 0) return offlinePage(cachedMessages, limit);
      } catch (cacheErr) {
        console.warn('[API] Cache fallback failed:', cacheErr);
      }

      // An empty page would make an outage render as a healthy, quiet inbox.
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

  iccidMappings: {
    async list(params: Readonly<Record<string, QueryValue | undefined>> = {}) {
      return await contractApi.iccidMappings.list({ query: queryText(params) });
    },

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
