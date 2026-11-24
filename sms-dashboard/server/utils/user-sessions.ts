// Reverse index user -> session tokens: SESSIONS is keyed by opaque token, so a role
// change could not otherwise find the user's sessions. KV is eventually consistent,
// so revocation is not instant.

import * as v from 'valibot';
import { readKvJson, type KV, type KVOperation } from '../lib/kv.js';

interface SessionEnv<Op extends KVOperation> {
  SESSIONS: KV<Op>;
}

const TokenIndex = v.fallback(
  v.pipe(
    v.array(v.unknown()),
    v.transform((items) => items.filter((item): item is string => typeof item === 'string')),
  ),
  () => [],
);

const INDEX_PREFIX = 'usess:';

const INDEX_TTL_SECONDS = 24 * 60 * 60;

function indexKey(userId: string): string {
  return `${INDEX_PREFIX}${userId}`;
}

async function readIndex(env: SessionEnv<'get'>, userId: string): Promise<string[]> {
  const stored = await readKvJson(env.SESSIONS, indexKey(userId), TokenIndex);
  if (stored === null) return [];
  if (!stored.ok) throw new Error(`Session index for ${userId} is not JSON: ${stored.error}`);
  return stored.value;
}

export async function indexSession(
  env: SessionEnv<'get' | 'put'>,
  userId: string | null | undefined,
  token: string | null | undefined,
): Promise<void> {
  if (!userId || !token) return;

  const tokens = await readIndex(env, userId);
  if (tokens.includes(token)) return;

  tokens.push(token);
  await env.SESSIONS.put(indexKey(userId), JSON.stringify(tokens), {
    expirationTtl: INDEX_TTL_SECONDS,
  });
}

export async function unindexSession(
  env: SessionEnv<'get' | 'put' | 'delete'>,
  userId: string | null | undefined,
  token: string | null | undefined,
): Promise<void> {
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

/** Sessions are deleted before the index, so a partial failure leaves dead tokens indexed, never live ones orphaned. */
export async function revokeUserSessions(
  env: SessionEnv<'get' | 'delete'>,
  userId: string | null | undefined,
): Promise<number> {
  if (!userId) return 0;

  const tokens = await readIndex(env, userId);

  for (const token of tokens) {
    await env.SESSIONS.delete(token);
  }

  await env.SESSIONS.delete(indexKey(userId));
  return tokens.length;
}
