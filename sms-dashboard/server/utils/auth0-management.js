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

import { createRoleConfig } from '../../config/auth0-roles.js';

const TOKEN_CACHE_PREFIX = 'mgmt-token:';
const ROLE_ID_CACHE_KEY = 'mgmt-role-ids';
// Refresh well before expiry so a request never races the boundary.
const TTL_LEEWAY = 0.2;

export class Auth0ManagementError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'Auth0ManagementError';
    this.status = status;
    this.body = body;
  }
}

function requireConfig(env) {
  const missing = ['AUTH0_DOMAIN', 'AUTH0_M2M_CLIENT_ID', 'AUTH0_M2M_CLIENT_SECRET'].filter(
    (k) => !env[k]
  );

  if (missing.length) {
    throw new Auth0ManagementError(
      `Auth0 Management API is not configured: missing ${missing.join(', ')}`,
      500,
      null
    );
  }
}

/**
 * Obtain an M2M access token for the Management API, cached in KV.
 *
 * Without caching this would mint a token per request, which Auth0 rate-limits and
 * bills against the tenant's M2M quota.
 */
export async function getManagementToken(env) {
  requireConfig(env);

  const cacheKey = `${TOKEN_CACHE_PREFIX}${env.AUTH0_M2M_CLIENT_ID}`;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env.AUTH0_M2M_CLIENT_ID,
      client_secret: env.AUTH0_M2M_CLIENT_SECRET,
      audience: `https://${env.AUTH0_DOMAIN}/api/v2/`,
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Auth0ManagementError(
      `Failed to obtain Auth0 Management token (${response.status})`,
      response.status,
      body
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Auth0ManagementError('Auth0 token response was not JSON', 502, body);
  }

  if (!parsed.access_token) {
    throw new Auth0ManagementError('Auth0 token response had no access_token', 502, body);
  }

  const expiresIn = Number(parsed.expires_in) || 0;
  const ttl = Math.floor(expiresIn - expiresIn * TTL_LEEWAY);

  // KV rejects expirationTtl below 60s; skip caching rather than fail the request.
  if (ttl >= 60) {
    await env.SESSIONS.put(cacheKey, parsed.access_token, { expirationTtl: ttl });
  }

  return parsed.access_token;
}

async function mgmtFetch(env, path, init = {}) {
  const token = await getManagementToken(env);

  const response = await fetch(`https://${env.AUTH0_DOMAIN}/api/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Auth0ManagementError(
      `Auth0 Management API ${init.method || 'GET'} ${path} failed (${response.status})`,
      response.status,
      text
    );
  }

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    throw new Auth0ManagementError(`Auth0 Management API returned non-JSON for ${path}`, 502, text);
  }
}

/**
 * Map the configured role names to Auth0 role IDs, cached in KV.
 *
 * The assign/remove endpoints take role IDs, not names, so this lookup is unavoidable.
 */
export async function resolveRoleIds(env) {
  const cached = await env.SESSIONS.get(ROLE_ID_CACHE_KEY, { type: 'json' });
  if (cached) return cached;

  const config = createRoleConfig(env);
  const roles = await mgmtFetch(env, '/roles?per_page=100');
  const wanted = [config.ADMIN_ROLE, config.VIEWER_ROLE];
  const map = {};

  for (const role of Array.isArray(roles) ? roles : []) {
    if (wanted.includes(role.name)) map[role.name] = role.id;
  }

  const missing = wanted.filter((name) => !map[name]);
  if (missing.length) {
    throw new Auth0ManagementError(
      `These roles do not exist in Auth0: ${missing.join(', ')}. Create them before deploying.`,
      500,
      JSON.stringify(Object.keys(map))
    );
  }

  await env.SESSIONS.put(ROLE_ID_CACHE_KEY, JSON.stringify(map), { expirationTtl: 3600 });
  return map;
}

const PER_PAGE = 100;
// Bounds the worst case rather than looping forever on a paging bug. 1000 users is far
// beyond this deployment; exceeding it is reported, never silently truncated.
const MAX_PAGES = 10;

/**
 * Fetch a paginated Management API collection.
 *
 * @returns {{items: any[], truncated: boolean, total: number}}
 */
async function fetchPaged(env, path, collectionKey) {
  const items = [];
  let total = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await mgmtFetch(
      env,
      `${path}${sep}per_page=${PER_PAGE}&page=${page}&include_totals=true`
    );

    const batch = body?.[collectionKey];
    if (!Array.isArray(batch)) break;

    items.push(...batch);
    total = Number(body.total) || items.length;

    if (items.length >= total || batch.length === 0) break;

    if (page === MAX_PAGES - 1 && items.length < total) truncated = true;
  }

  return { items, truncated, total };
}

/** Users in the tenant, with only the fields the admin UI needs. */
export async function listUsers(env) {
  const { items } = await fetchPaged(
    env,
    '/users?fields=user_id,email,name,last_login,logins_count&include_fields=true',
    'users'
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
export async function getRoleMembers(env, roleId) {
  const { items } = await fetchPaged(env, `/roles/${encodeURIComponent(roleId)}/users`, 'users');
  return items;
}

/**
 * Every user plus the single role this app cares about, in a constant number of requests:
 * one token, one role-id lookup (both cached), one user list, and one membership call per
 * role — regardless of how many users exist.
 *
 * @returns {{users: any[], roleByUserId: Map<string,string>}}
 */
export async function listUsersWithRoles(env) {
  const config = createRoleConfig(env);
  const roleIds = await resolveRoleIds(env);

  const users = await listUsers(env);
  const roleByUserId = new Map();

  // Sequential, not Promise.all: two calls that must not race the rate limiter.
  for (const roleName of [config.VIEWER_ROLE, config.ADMIN_ROLE]) {
    const members = await getRoleMembers(env, roleIds[roleName]);
    for (const member of members) {
      // Admin is applied last so it wins if somebody holds both.
      roleByUserId.set(member.user_id, roleName);
    }
  }

  return { users, roleByUserId };
}

/** The role names currently assigned to a user. */
export async function getUserRoles(env, userId) {
  const roles = await mgmtFetch(env, `/users/${encodeURIComponent(userId)}/roles`);
  return (Array.isArray(roles) ? roles : []).map((r) => r.name);
}

export async function assignRoleByName(env, userId, roleName) {
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

export async function removeRolesByName(env, userId, roleNames) {
  if (!roleNames.length) return;

  const ids = await resolveRoleIds(env);
  const toRemove = roleNames.map((n) => ids[n]).filter(Boolean);

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
export async function setUserRole(env, userId, roleName) {
  const config = createRoleConfig(env);
  const known = [config.ADMIN_ROLE, config.VIEWER_ROLE];

  if (!known.includes(roleName)) {
    throw new Auth0ManagementError(`Unknown role '${roleName}'`, 400, null);
  }

  await assignRoleByName(env, userId, roleName);
  await removeRolesByName(
    env,
    userId,
    known.filter((n) => n !== roleName)
  );
}
