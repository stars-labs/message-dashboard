// Run with: bun test server/utils/auth0-management.test.js
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  Auth0ManagementError,
  getManagementToken,
  getRoleMembers,
  getUserRoles,
  listUsers,
  resolveRoleIds,
  setUserRole,
} from './auth0-management.js';

// Minimal in-memory stand-in for a Workers KV namespace.
function kvStub() {
  const store = new Map();
  return {
    store,
    puts: [],
    async get(key, options) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return options?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value, options) {
      this.puts.push({ key, value, options });
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    AUTH0_DOMAIN: 'tenant.auth0.com',
    AUTH0_M2M_CLIENT_ID: 'm2m-client',
    AUTH0_M2M_CLIENT_SECRET: 'm2m-secret',
    SESSIONS: kvStub(),
    ...overrides,
  };
}

let calls;
const realFetch = globalThis.fetch;

// Queue of responses, matched in order. Each entry: {status, body}.
function mockFetch(responses) {
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body, headers: init.headers });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
    });
  };
}

const TOKEN_OK = { body: { access_token: 'mgmt-token', expires_in: 86400 } };
const ROLES_OK = { body: [{ id: 'rol_admin', name: 'admin' }, { id: 'rol_viewer', name: 'viewer' }] };

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('getManagementToken', () => {
  test('requests a client_credentials token for the Management API audience', async () => {
    mockFetch([TOKEN_OK]);
    const env = makeEnv();

    expect(await getManagementToken(env)).toBe('mgmt-token');
    expect(calls[0].url).toBe('https://tenant.auth0.com/oauth/token');
    const sent = JSON.parse(calls[0].body);
    expect(sent.grant_type).toBe('client_credentials');
    expect(sent.audience).toBe('https://tenant.auth0.com/api/v2/');
  });

  test('caches the token in KV with a TTL below its expiry', async () => {
    mockFetch([TOKEN_OK]);
    const env = makeEnv();

    await getManagementToken(env);
    const put = env.SESSIONS.puts.find((p) => p.key.startsWith('mgmt-token:'));
    expect(put.value).toBe('mgmt-token');
    // 86400 minus 20% leeway.
    expect(put.options.expirationTtl).toBe(69120);
  });

  test('reuses a cached token instead of minting a new one', async () => {
    mockFetch([TOKEN_OK]);
    const env = makeEnv();

    await getManagementToken(env);
    const afterFirst = calls.length;
    expect(await getManagementToken(env)).toBe('mgmt-token');
    expect(calls.length).toBe(afterFirst); // no second network call
  });

  test('does not cache when the TTL would be under KV minimum', async () => {
    mockFetch([{ body: { access_token: 't', expires_in: 30 } }]);
    const env = makeEnv();

    await getManagementToken(env);
    expect(env.SESSIONS.puts.filter((p) => p.key.startsWith('mgmt-token:'))).toHaveLength(0);
  });

  // A Management API failure must never look like success — these calls grant access.
  test('throws on a non-2xx token response', async () => {
    mockFetch([{ status: 401, body: { error: 'access_denied' } }]);

    await expect(getManagementToken(makeEnv())).rejects.toThrow(Auth0ManagementError);
  });

  test('throws when the response has no access_token', async () => {
    mockFetch([{ body: { not_a_token: true } }]);

    await expect(getManagementToken(makeEnv())).rejects.toThrow(/no access_token/);
  });

  test('throws a configuration error when M2M secrets are absent', async () => {
    mockFetch([TOKEN_OK]);
    const env = makeEnv({ AUTH0_M2M_CLIENT_SECRET: undefined });

    await expect(getManagementToken(env)).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0); // fails before any network call
  });
});

describe('resolveRoleIds', () => {
  test('maps configured role names to Auth0 role ids', async () => {
    mockFetch([TOKEN_OK, ROLES_OK]);

    expect(await resolveRoleIds(makeEnv())).toEqual({ admin: 'rol_admin', viewer: 'rol_viewer' });
  });

  test('caches the map in KV', async () => {
    mockFetch([TOKEN_OK, ROLES_OK]);
    const env = makeEnv();

    await resolveRoleIds(env);
    const before = calls.length;
    await resolveRoleIds(env);
    expect(calls.length).toBe(before);
  });

  // Deploying without creating the roles is the most likely setup mistake; it must be a
  // loud error naming what is missing, not a silent empty map.
  test('throws naming the roles that do not exist in Auth0', async () => {
    mockFetch([TOKEN_OK, { body: [{ id: 'rol_viewer', name: 'viewer' }] }]);

    await expect(resolveRoleIds(makeEnv())).rejects.toThrow(/do not exist in Auth0: admin/);
  });

  test('honours renamed roles', async () => {
    mockFetch([TOKEN_OK, { body: [{ id: 'r1', name: 'superuser' }, { id: 'r2', name: 'viewer' }] }]);

    const env = makeEnv({ AUTH0_ADMIN_ROLE: 'superuser' });
    expect(await resolveRoleIds(env)).toEqual({ superuser: 'r1', viewer: 'r2' });
  });
});

describe('listUsers / getUserRoles', () => {
  test('listUsers returns the paginated users collection', async () => {
    mockFetch([
      TOKEN_OK,
      { body: { users: [{ user_id: 'auth0|1', email: 'a@poloniex.com' }], total: 1, start: 0, limit: 100 } },
    ]);

    const users = await listUsers(makeEnv());
    expect(users).toHaveLength(1);
    expect(calls[1].url).toContain('/api/v2/users?');
    expect(calls[1].url).toContain('include_totals=true');
  });

  test('listUsers pages until it has every user', async () => {
    const page = (n, ids) => ({ body: { users: ids.map((i) => ({ user_id: `auth0|${i}` })), total: n, start: 0, limit: 100 } });
    mockFetch([
      TOKEN_OK,
      page(3, [1, 2]), // first page, 2 of 3
      page(3, [3]),    // second page, the remainder
    ]);

    expect(await listUsers(makeEnv())).toHaveLength(3);
  });

  test('getRoleMembers asks for the role\'s members, not each user\'s roles', async () => {
    mockFetch([TOKEN_OK, { body: { users: [{ user_id: 'auth0|1' }], total: 1 } }]);

    const members = await getRoleMembers(makeEnv(), 'rol_admin');
    expect(members).toHaveLength(1);
    expect(calls[1].url).toContain('/roles/rol_admin/users');
  });

  test('getUserRoles returns role names and url-encodes the user id', async () => {
    mockFetch([TOKEN_OK, { body: [{ id: 'rol_admin', name: 'admin' }] }]);

    expect(await getUserRoles(makeEnv(), 'auth0|abc')).toEqual(['admin']);
    expect(calls[1].url).toContain('auth0%7Cabc');
  });

  test('a 500 from the API propagates as an error', async () => {
    mockFetch([TOKEN_OK, { status: 500, body: 'boom' }]);

    await expect(listUsers(makeEnv())).rejects.toThrow(Auth0ManagementError);
  });
});

describe('setUserRole', () => {
  test('assigns the target role then removes the other one', async () => {
    mockFetch([TOKEN_OK, ROLES_OK, { body: {} }, { body: {} }]);

    await setUserRole(makeEnv(), 'auth0|1', 'admin');

    const mutations = calls.filter((c) => c.method === 'POST' || c.method === 'DELETE');
    const assign = mutations.find((c) => c.method === 'POST' && c.url.includes('/roles'));
    const remove = mutations.find((c) => c.method === 'DELETE');

    expect(JSON.parse(assign.body)).toEqual({ roles: ['rol_admin'] });
    expect(JSON.parse(remove.body)).toEqual({ roles: ['rol_viewer'] });
    // Assign must precede remove, so a mid-way failure leaves access rather than lockout.
    expect(mutations.indexOf(assign)).toBeLessThan(mutations.indexOf(remove));
  });

  test('works in the viewer direction too', async () => {
    mockFetch([TOKEN_OK, ROLES_OK, { body: {} }, { body: {} }]);

    await setUserRole(makeEnv(), 'auth0|1', 'viewer');
    const assign = calls.find((c) => c.method === 'POST' && c.url.includes('/roles'));
    expect(JSON.parse(assign.body)).toEqual({ roles: ['rol_viewer'] });
  });

  // No arbitrary role injection, even before the handler's own allow-list.
  test('rejects a role outside the known set', async () => {
    mockFetch([TOKEN_OK, ROLES_OK]);

    for (const bad of ['superadmin', 'sms', '', 'ADMIN']) {
      await expect(setUserRole(makeEnv(), 'auth0|1', bad)).rejects.toThrow(/Unknown role/);
    }
  });
});
