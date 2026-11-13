// Per-user index of live session tokens.
//
// Roles are snapshotted into the KV session at login, so without this a demotion or
// revocation does nothing until the session expires 24 hours later. The `SESSIONS` KV is
// keyed by opaque token, which cannot be searched by user, so we maintain a reverse
// index and use it to drop every session a user holds when their role changes.
//
// Caveat, worth being precise about: Workers KV is eventually consistent, so revocation
// is bounded by KV propagation (worst case ~60s), not instant. That is still 60 seconds
// instead of 24 hours. True instant revocation would need a per-request D1 lookup, which
// is not worth the added latency on every API call.

import type { Env } from '../worker-context.js';

const INDEX_PREFIX = 'usess:';

// Matches the session TTL, so an abandoned index cannot outlive the sessions it lists.
const INDEX_TTL_SECONDS = 24 * 60 * 60;

function indexKey(userId: string): string {
  return `${INDEX_PREFIX}${userId}`;
}

async function readIndex(env: Env, userId: string): Promise<string[]> {
  const raw = await env.SESSIONS.get<unknown>(indexKey(userId), { type: 'json' });
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

/** Record that `token` is a live session for `userId`. Called at login. */
export async function indexSession(env: Env, userId: string, token: string): Promise<void> {
  if (!userId || !token) return;

  const tokens = await readIndex(env, userId);
  if (tokens.includes(token)) return;

  tokens.push(token);
  await env.SESSIONS.put(indexKey(userId), JSON.stringify(tokens), {
    expirationTtl: INDEX_TTL_SECONDS,
  });
}

/** Drop a single token from the index. Called at logout. */
export async function unindexSession(env: Env, userId: string, token: string): Promise<void> {
  if (!userId || !token) return;

  const remaining = (await readIndex(env, userId)).filter((t) => t !== token);

  if (remaining.length === 0) {
    await env.SESSIONS.delete(indexKey(userId));
    return;
  }

  await env.SESSIONS.put(indexKey(userId), JSON.stringify(remaining), {
    expirationTtl: INDEX_TTL_SECONDS,
  });
}

/**
 * Delete every session belonging to `userId`, forcing re-authentication.
 *
 * Returns the number of sessions dropped. Sessions are deleted before the index, so a
 * failure part-way leaves the index pointing at already-dead tokens (harmless) rather
 * than orphaning live sessions with no way to find them.
 */
export async function revokeUserSessions(env: Env, userId: string): Promise<number> {
  if (!userId) return 0;

  const tokens = await readIndex(env, userId);

  for (const token of tokens) {
    await env.SESSIONS.delete(token);
  }

  await env.SESSIONS.delete(indexKey(userId));
  return tokens.length;
}
