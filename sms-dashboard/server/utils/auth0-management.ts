// Auth0 Management API client.
//
// Used to read the tenant's users/roles and to change a user's role. Auth0 remains the
// source of truth for roles; this app never stores them.
//
// Requires a machine-to-machine application authorised for the Management API with
// scopes `read:users`, `read:roles`, `update:users` — deliberately NOT `delete:users`.
// Credentials come from the AUTH0_M2M_CLIENT_ID / AUTH0_M2M_CLIENT_SECRET secrets.
//
// Every failure throws. A Management API error must never be swallowed into an apparent
// success: the callers use this to grant and revoke access.

import * as v from 'valibot';
import { createRoleConfig, type RoleEnv } from '../../config/auth0-roles.js';
import { parseJson } from '../../shared/parse-json.js';
import { readKvJson, type KV } from '../lib/kv.js';

export interface Auth0ManagementEnv extends RoleEnv {
  AUTH0_DOMAIN?: string;
  AUTH0_M2M_CLIENT_ID?: string;
  AUTH0_M2M_CLIENT_SECRET?: string;
  SESSIONS: KV<'get' | 'put'>;
}

const TOKEN_CACHE_PREFIX = 'mgmt-token:';
const ROLE_ID_CACHE_KEY = 'mgmt-role-ids';
// Refresh well before expiry so a request never races the boundary.
const TTL_LEEWAY = 0.2;

export class Auth0ManagementError extends Error {
  status: number;
  body: string | null;

  constructor(message: string, status: number, body: string | null) {
    super(message);
    this.name = 'Auth0ManagementError';
    this.status = status;
    this.body = body;
  }
}

/** The Management API user record, limited to the fields this app requests. */
const Auth0UserSchema = v.object({
  user_id: v.string(),
  email: v.nullish(v.string()),
  name: v.nullish(v.string()),
  last_login: v.nullish(v.string()),
  logins_count: v.nullish(v.number()),
});

export type Auth0User = v.InferOutput<typeof Auth0UserSchema>;

/** A role as the Management API returns it. */
const Auth0RoleSchema = v.object({ id: v.string(), name: v.string() });

/** Role name -> role id cache. */
const RoleIdMapSchema = v.record(v.string(), v.string());

type RoleIdMap = v.InferOutput<typeof RoleIdMapSchema>;

const TokenResponse = v.object({
  access_token: v.optional(v.unknown()),
  expires_in: v.optional(v.unknown()),
});

const UsersPage = v.object({
  users: v.optional(v.unknown()),
  total: v.optional(v.unknown()),
});

function malformed(path: string, body: string, error: string): Auth0ManagementError {
  return new Auth0ManagementError(
    `Auth0 Management API returned an unexpected shape for ${path}: ${error}`,
    502,
    body,
  );
}

function requireConfig(env: Auth0ManagementEnv): {
  domain: string;
  clientId: string;
  clientSecret: string;
} {
  const {
    AUTH0_DOMAIN: domain,
    AUTH0_M2M_CLIENT_ID: clientId,
    AUTH0_M2M_CLIENT_SECRET: secret,
  } = env;

  if (!domain || !clientId || !secret) {
    const missing = [
      ['AUTH0_DOMAIN', domain],
      ['AUTH0_M2M_CLIENT_ID', clientId],
      ['AUTH0_M2M_CLIENT_SECRET', secret],
    ].filter(([, value]) => !value);
    throw new Auth0ManagementError(
      `Auth0 Management API is not configured: missing ${missing.map(([name]) => name).join(', ')}`,
      500,
      null,
    );
  }

  return { domain, clientId, clientSecret: secret };
}

/**
 * Obtain an M2M access token for the Management API, cached in KV.
 *
 * Without caching this would mint a token per request, which Auth0 rate-limits and
 * bills against the tenant's M2M quota.
 */
export async function getManagementToken(env: Auth0ManagementEnv): Promise<string> {
  const { domain, clientId, clientSecret } = requireConfig(env);

  const cacheKey = `${TOKEN_CACHE_PREFIX}${clientId}`;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Auth0ManagementError(
      `Failed to obtain Auth0 Management token (${response.status})`,
      response.status,
      body,
    );
  }

  const json = parseJson(body, v.unknown());
  if (!json.ok) {
    throw new Auth0ManagementError('Auth0 token response was not JSON', 502, body);
  }

  const parsed = v.safeParse(TokenResponse, json.value);
  const fields = parsed.success
    ? parsed.output
    : { access_token: undefined, expires_in: undefined };
  const accessToken = fields.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Auth0ManagementError('Auth0 token response had no access_token', 502, body);
  }

  const expiresIn = Number(fields.expires_in) || 0;
  const ttl = Math.floor(expiresIn - expiresIn * TTL_LEEWAY);

  // KV rejects expirationTtl below 60s; skip caching rather than fail the request.
  if (ttl >= 60) {
    await env.SESSIONS.put(cacheKey, accessToken, { expirationTtl: ttl });
  }

  return accessToken;
}

/** One Management API call. Returns the parsed body, or null for an empty 2xx. */
async function mgmtFetch(
  env: Auth0ManagementEnv,
  path: string,
  { method = 'GET', body }: { method?: 'GET' | 'POST' | 'DELETE'; body?: string } = {},
): Promise<unknown> {
  const { domain } = requireConfig(env);
  const token = await getManagementToken(env);

  const response = await fetch(`https://${domain}/api/v2${path}`, {
    method,
    ...(body === undefined ? {} : { body }),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Auth0ManagementError(
      `Auth0 Management API ${method} ${path} failed (${response.status})`,
      response.status,
      text,
    );
  }

  if (!text) return null;

  const json = parseJson(text, v.unknown());
  if (!json.ok) {
    throw new Auth0ManagementError(`Auth0 Management API returned non-JSON for ${path}`, 502, text);
  }
  return json.value;
}

function parseItems<T>(items: unknown[], schema: v.GenericSchema<unknown, T>, path: string): T[] {
  return items.map((item) => {
    const parsed = v.safeParse(schema, item);
    if (!parsed.success) throw malformed(path, JSON.stringify(item), v.summarize(parsed.issues));
    return parsed.output;
  });
}

const PER_PAGE = 100;
// Bounds the worst case rather than looping forever on a paging bug. 1000 users is far
// beyond this deployment; exceeding it is reported, never silently truncated.
const MAX_PAGES = 10;

/** Fetch a paginated Management API collection of users. */
async function fetchPagedUsers(
  env: Auth0ManagementEnv,
  path: string,
): Promise<{ items: Auth0User[]; truncated: boolean; total: number }> {
  const items: Auth0User[] = [];
  let total = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const pagePath = `${path}${sep}per_page=${PER_PAGE}&page=${page}&include_totals=true`;
    const parsed = v.safeParse(UsersPage, await mgmtFetch(env, pagePath));

    if (!parsed.success) break;
    const batch = parsed.output.users;
    if (!Array.isArray(batch)) break;

    items.push(...parseItems(batch, Auth0UserSchema, pagePath));
    total = Number(parsed.output.total) || items.length;

    if (items.length >= total || batch.length === 0) break;

    if (page === MAX_PAGES - 1 && items.length < total) truncated = true;
  }

  return { items, truncated, total };
}

/**
 * Map the configured role names to Auth0 role IDs, cached in KV.
 *
 * The assign/remove endpoints take role IDs, not names, so this lookup is unavoidable.
 * Throws when a configured role does not exist in the tenant: assigning against a
 * missing id would silently target `/roles/undefined/users`.
 */
export async function resolveRoleIds(env: Auth0ManagementEnv): Promise<RoleIdMap> {
  const cached = await readKvJson(env.SESSIONS, ROLE_ID_CACHE_KEY, RoleIdMapSchema);
  if (cached?.ok) return cached.value;

  const config = createRoleConfig(env);
  const rolesPath = '/roles?per_page=100';
  const roles = await mgmtFetch(env, rolesPath);
  const wanted = [config.ADMIN_ROLE, config.VIEWER_ROLE];
  const map: RoleIdMap = {};

  for (const role of parseItems(Array.isArray(roles) ? roles : [], Auth0RoleSchema, rolesPath)) {
    if (wanted.includes(role.name)) map[role.name] = role.id;
  }

  const missing = wanted.filter((name) => !map[name]);
  if (missing.length) {
    throw new Auth0ManagementError(
      `These roles do not exist in Auth0: ${missing.join(', ')}. Create them before deploying.`,
      500,
      JSON.stringify(Object.keys(map)),
    );
  }

  await env.SESSIONS.put(ROLE_ID_CACHE_KEY, JSON.stringify(map), { expirationTtl: 3600 });
  return map;
}

/** Users in the tenant, with only the fields the admin UI needs. */
export async function listUsers(env: Auth0ManagementEnv): Promise<Auth0User[]> {
  const { items } = await fetchPagedUsers(
    env,
    '/users?fields=user_id,email,name,last_login,logins_count&include_fields=true',
  );

  return items;
}

/**
 * The users holding a given role.
 *
 * This is the inverse of asking each user for their roles, and it is the difference
 * between a constant number of Management API calls and one per user. The per-user
 * version was concurrent via Promise.all and reliably returned HTTP 429 (rate limited)
 * once the tenant had more than a handful of users.
 */
export async function getRoleMembers(
  env: Auth0ManagementEnv,
  roleId: string,
): Promise<Auth0User[]> {
  const { items } = await fetchPagedUsers(env, `/roles/${encodeURIComponent(roleId)}/users`);
  return items;
}

/**
 * Every user plus the single role this app cares about, in a constant number of requests:
 * one token, one role-id lookup (both cached), one user list, and one membership call per
 * role — regardless of how many users exist.
 */
export async function listUsersWithRoles(
  env: Auth0ManagementEnv,
): Promise<{ users: Auth0User[]; roleByUserId: Map<string, string> }> {
  const config = createRoleConfig(env);
  const roleIds = await resolveRoleIds(env);

  const users = await listUsers(env);
  const roleByUserId = new Map<string, string>();

  // Sequential, not Promise.all: two calls that must not race the rate limiter.
  for (const roleName of [config.VIEWER_ROLE, config.ADMIN_ROLE]) {
    const roleId = roleIds[roleName];
    if (roleId === undefined) {
      throw new Auth0ManagementError(`Unknown role '${roleName}'`, 500, null);
    }
    const members = await getRoleMembers(env, roleId);
    for (const member of members) {
      // Admin is applied last so it wins if somebody holds both.
      roleByUserId.set(member.user_id, roleName);
    }
  }

  return { users, roleByUserId };
}

/** The role names currently assigned to a user. */
export async function getUserRoles(env: Auth0ManagementEnv, userId: string): Promise<string[]> {
  const path = `/users/${encodeURIComponent(userId)}/roles`;
  const roles = await mgmtFetch(env, path);
  return parseItems(Array.isArray(roles) ? roles : [], Auth0RoleSchema, path).map((r) => r.name);
}

export async function assignRoleByName(
  env: Auth0ManagementEnv,
  userId: string,
  roleName: string,
): Promise<void> {
  const ids = await resolveRoleIds(env);
  const id = ids[roleName];

  if (!id) {
    throw new Auth0ManagementError(`Unknown role '${roleName}'`, 400, null);
  }

  await mgmtFetch(env, `/users/${encodeURIComponent(userId)}/roles`, {
    method: 'POST',
    body: JSON.stringify({ roles: [id] }),
  });
}

export async function removeRolesByName(
  env: Auth0ManagementEnv,
  userId: string,
  roleNames: string[],
): Promise<void> {
  if (!roleNames.length) return;

  const ids = await resolveRoleIds(env);
  const toRemove = roleNames.map((n) => ids[n]).filter((id) => id !== undefined && id !== '');

  if (!toRemove.length) return;

  await mgmtFetch(env, `/users/${encodeURIComponent(userId)}/roles`, {
    method: 'DELETE',
    body: JSON.stringify({ roles: toRemove }),
  });
}

/**
 * Make `roleName` the user's only role among the known ones.
 *
 * Assign-then-remove, deliberately in that order: if the remove fails the user is left
 * with both roles (over-privileged but working) rather than none (locked out). The
 * caller is expected to have already validated `roleName`.
 */
export async function setUserRole(
  env: Auth0ManagementEnv,
  userId: string,
  roleName: string,
): Promise<void> {
  const config = createRoleConfig(env);
  const known = [config.ADMIN_ROLE, config.VIEWER_ROLE];

  if (!known.includes(roleName)) {
    throw new Auth0ManagementError(`Unknown role '${roleName}'`, 400, null);
  }

  await assignRoleByName(env, userId, roleName);
  await removeRolesByName(
    env,
    userId,
    known.filter((n) => n !== roleName),
  );
}
