// Run with: bun test server/utils/auth0-management.test.ts
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import {
  Auth0ManagementError,
  assignRoleByName,
  getManagementToken,
  getRoleMembers,
  getUserRoles,
  listUsers,
  listUsersWithRoles,
  removeRolesByName,
  resolveRoleIds,
  setUserRole,
  type Auth0ManagementEnv,
} from './auth0-management.js';

interface Put {
  key: string;
  value: string;
  options: { expirationTtl?: number } | undefined;
}

// Minimal in-memory stand-in for a Workers KV namespace.
function kvStub() {
  const store = new Map<string, string>();
  const puts: Put[] = [];
  return {
    store,
    puts,
    get(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      puts.push({ key, value, options });
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

interface TestEnv extends Auth0ManagementEnv {
  SESSIONS: ReturnType<typeof kvStub>;
}

function makeEnv(overrides: { AUTH0_ADMIN_ROLE?: string } = {}): TestEnv {
  return {
    AUTH0_DOMAIN: 'tenant.auth0.com',
    AUTH0_M2M_CLIENT_ID: 'm2m-client',
    AUTH0_M2M_CLIENT_SECRET: 'm2m-secret',
    SESSIONS: kvStub(),
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

interface Reply {
  status?: number;
  body: unknown;
}

let calls: Call[];
let fetchSpy: Mock<typeof fetch>;

// Queue of responses, matched in order; the last one repeats.
function mockFetch(responses: Reply[]) {
  let i = 0;
  const respond = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (!r) throw new Error('mockFetch needs at least one response');
    return Promise.resolve(
      new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
        status: r.status ?? 200,
      }),
    );
  };
  fetchSpy.mockImplementation(Object.assign(respond, { preconnect: () => undefined }));
}

function sent(call: Call | undefined): unknown {
  const parsed = parseJson(call?.body ?? '', v.unknown());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

async function failure(promise: Promise<unknown>): Promise<Auth0ManagementError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Auth0ManagementError) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

const TOKEN_OK = { body: { access_token: 'mgmt-token', expires_in: 86400 } };
const ROLES_OK = {
  body: [
    { id: 'rol_admin', name: 'admin' },
    { id: 'rol_viewer', name: 'viewer' },
  ],
};

beforeEach(() => {
  calls = [];
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('getManagementToken', () => {
  test('requests a client_credentials token for the Management API audience', async () => {
    mockFetch([TOKEN_OK]);
    const env = makeEnv();

    expect(await getManagementToken(env)).toBe('mgmt-token');
    expect(calls[0]?.url).toBe('https://tenant.auth0.com/oauth/token');
    expect(sent(calls[0])).toEqual({
      grant_type: 'client_credentials',
      client_id: 'm2m-client',
      client_secret: 'm2m-secret',
      audience: 'https://tenant.auth0.com/api/v2/',
    });
  });

  test('caches the token in KV with a TTL below its expiry', async () => {
    mockFetch([TOKEN_OK]);
    const env = makeEnv();

    await getManagementToken(env);
    const put = env.SESSIONS.puts.find((p) => p.key.startsWith('mgmt-token:'));
    expect(put?.value).toBe('mgmt-token');
    // 86400 minus 20% leeway.
    expect(put?.options?.expirationTtl).toBe(69120);
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

  test('does not cache a token that carries no expiry', async () => {
    mockFetch([{ body: { access_token: 't' } }]);
    const env = makeEnv();

    expect(await getManagementToken(env)).toBe('t');
    expect(env.SESSIONS.puts).toHaveLength(0);
  });

  // A Management API failure must never look like success — these calls grant access.
  test('throws on a non-2xx token response', async () => {
    mockFetch([{ status: 401, body: { error: 'access_denied' } }]);

    const error = await failure(getManagementToken(makeEnv()));
    expect(error.message).toBe('Failed to obtain Auth0 Management token (401)');
    expect(error.status).toBe(401);
    expect(error.body).toBe('{"error":"access_denied"}');
  });

  test('throws when the response has no access_token', async () => {
    for (const body of [{ not_a_token: true }, { access_token: '' }, { access_token: 7 }, null]) {
      mockFetch([{ body }]);
      const error = await failure(getManagementToken(makeEnv()));
      expect(error.message).toBe('Auth0 token response had no access_token');
      expect(error.status).toBe(502);
    }
  });

  test('throws a 502 when the token response is not JSON', async () => {
    mockFetch([{ body: '<html>' }]);

    const error = await failure(getManagementToken(makeEnv()));
    expect(error.message).toBe('Auth0 token response was not JSON');
    expect(error.status).toBe(502);
    expect(error.body).toBe('<html>');
  });

  test('throws a configuration error when M2M secrets are absent', async () => {
    mockFetch([TOKEN_OK]);
    const { AUTH0_M2M_CLIENT_SECRET: _omitted, ...env } = makeEnv();

    expect((await failure(getManagementToken(env))).message).toMatch(/not configured/);
    expect(calls).toHaveLength(0); // fails before any network call
  });

  test('names every missing setting, counting an empty one as missing', async () => {
    mockFetch([TOKEN_OK]);
    const { AUTH0_DOMAIN: _domain, ...rest } = makeEnv();

    const error = await failure(getManagementToken({ ...rest, AUTH0_M2M_CLIENT_ID: '' }));
    expect(error.message).toBe(
      'Auth0 Management API is not configured: missing AUTH0_DOMAIN, AUTH0_M2M_CLIENT_ID',
    );
    expect(error.status).toBe(500);
    expect(error.body).toBeNull();
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
    expect(env.SESSIONS.puts.at(-1)).toEqual({
      key: 'mgmt-role-ids',
      value: '{"admin":"rol_admin","viewer":"rol_viewer"}',
      options: { expirationTtl: 3600 },
    });
  });

  // Deploying without creating the roles is the most likely setup mistake; it must be a
  // loud error naming what is missing, not a silent empty map.
  test('throws naming the roles that do not exist in Auth0', async () => {
    mockFetch([TOKEN_OK, { body: [{ id: 'rol_viewer', name: 'viewer' }] }]);

    const error = await failure(resolveRoleIds(makeEnv()));
    expect(error.message).toMatch(/do not exist in Auth0: admin\./);
    expect(error.status).toBe(500);
    expect(error.body).toBe('["viewer"]');
  });

  test('fails with 502 for a roles response that is not a list', async () => {
    mockFetch([TOKEN_OK, { body: { roles: [] } }]);

    const error = await failure(resolveRoleIds(makeEnv()));
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/unexpected shape/);
  });

  test('ignores roles the app does not use', async () => {
    mockFetch([
      TOKEN_OK,
      { body: [...ROLES_OK.body, { id: 'rol_other', name: 'balance-runner' }] },
    ]);

    expect(await resolveRoleIds(makeEnv())).toEqual({ admin: 'rol_admin', viewer: 'rol_viewer' });
  });

  test('refetches when the cached map is unreadable', async () => {
    mockFetch([TOKEN_OK, ROLES_OK]);
    const env = makeEnv();
    env.SESSIONS.store.set('mgmt-role-ids', '{"admin":7}');

    expect(await resolveRoleIds(env)).toEqual({ admin: 'rol_admin', viewer: 'rol_viewer' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://tenant.auth0.com/oauth/token',
      'https://tenant.auth0.com/api/v2/roles?per_page=100',
    ]);
  });

  test('honours renamed roles', async () => {
    mockFetch([
      TOKEN_OK,
      {
        body: [
          { id: 'r1', name: 'superuser' },
          { id: 'r2', name: 'viewer' },
        ],
      },
    ]);

    const env = makeEnv({ AUTH0_ADMIN_ROLE: 'superuser' });
    expect(await resolveRoleIds(env)).toEqual({ superuser: 'r1', viewer: 'r2' });
  });
});

describe('listUsers / getUserRoles', () => {
  test('listUsers returns the paginated users collection', async () => {
    mockFetch([
      TOKEN_OK,
      {
        body: {
          users: [{ user_id: 'auth0|1', email: 'a@poloniex.com' }],
          total: 1,
          start: 0,
          limit: 100,
        },
      },
    ]);

    const users = await listUsers(makeEnv());
    expect(users).toHaveLength(1);
    expect(calls[1]?.url).toContain('/api/v2/users?');
    expect(calls[1]?.url).toContain('include_totals=true');
  });

  test('listUsers pages until it has every user', async () => {
    const page = (n: number, ids: number[]): Reply => ({
      body: { users: ids.map((i) => ({ user_id: `auth0|${i}` })), total: n, start: 0, limit: 100 },
    });
    mockFetch([
      TOKEN_OK,
      page(3, [1, 2]), // first page, 2 of 3
      page(3, [3]), // second page, the remainder
    ]);

    expect(await listUsers(makeEnv())).toHaveLength(3);
    expect(calls.slice(1).map((c) => /&page=(\d+)/.exec(c.url)?.[1])).toEqual(['0', '1']);
  });

  test('listUsers stops at the page limit instead of looping forever', async () => {
    mockFetch([TOKEN_OK, { body: { users: [{ user_id: 'auth0|1' }], total: 1000 } }]);

    expect(await listUsers(makeEnv())).toHaveLength(10);
    expect(calls).toHaveLength(11);
  });

  test('listUsers stops on an empty page', async () => {
    mockFetch([TOKEN_OK, { body: { users: [], total: 5 } }]);
    expect(await listUsers(makeEnv())).toEqual([]);
  });

  test('listUsers fails with 502 instead of returning a truncated list for a malformed page', async () => {
    for (const body of [{ total: 5 }, '', { users: 'nope', total: 1 }, { users: [] }]) {
      mockFetch([TOKEN_OK, { body }]);
      const error = await listUsers(makeEnv()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Auth0ManagementError);
      expect(error instanceof Auth0ManagementError && error.status).toBe(502);
    }
  });

  test('listUsers keeps the profile fields it asks Auth0 for', async () => {
    const user = {
      user_id: 'auth0|1',
      email: 'a@poloniex.com',
      name: 'A',
      last_login: '2026-11-01T00:00:00.000Z',
      logins_count: 4,
    };
    mockFetch([TOKEN_OK, { body: { users: [user], total: 1 } }]);

    expect(await listUsers(makeEnv())).toEqual([user]);
  });

  test('listUsers rejects a user record without a user_id', async () => {
    mockFetch([TOKEN_OK, { body: { users: [{ email: 'a@poloniex.com' }], total: 1 } }]);

    const error = await failure(listUsers(makeEnv()));
    expect(error.status).toBe(502);
  });

  test("getRoleMembers asks for the role's members, not each user's roles", async () => {
    mockFetch([TOKEN_OK, { body: { users: [{ user_id: 'auth0|1' }], total: 1 } }]);

    const members = await getRoleMembers(makeEnv(), 'rol_admin');
    expect(members).toHaveLength(1);
    expect(calls[1]?.url).toContain('/roles/rol_admin/users');
  });

  test('getUserRoles returns role names and url-encodes the user id', async () => {
    mockFetch([TOKEN_OK, { body: [{ id: 'rol_admin', name: 'admin' }] }]);

    expect(await getUserRoles(makeEnv(), 'auth0|abc')).toEqual(['admin']);
    expect(calls[1]?.url).toContain('auth0%7Cabc');
  });

  test('getUserRoles fails with 502 instead of reporting no roles for a response that is not a list', async () => {
    for (const body of [{ roles: [] }, '']) {
      mockFetch([TOKEN_OK, { body }]);
      const error = await failure(getUserRoles(makeEnv(), 'auth0|abc'));
      expect(error.status).toBe(502);
    }
  });

  test('getUserRoles rejects a role without a name', async () => {
    mockFetch([TOKEN_OK, { body: [{ id: 'rol_admin' }] }]);

    const error = await failure(getUserRoles(makeEnv(), 'auth0|abc'));
    expect(error.status).toBe(502);
  });

  test('a 500 from the API propagates as an error', async () => {
    mockFetch([TOKEN_OK, { status: 500, body: 'boom' }]);

    const error = await failure(getUserRoles(makeEnv(), 'u1'));
    expect(error.message).toBe('Auth0 Management API GET /users/u1/roles failed (500)');
    expect(error.status).toBe(500);
    expect(error.body).toBe('boom');
  });

  test('a body that is not JSON propagates as a 502', async () => {
    mockFetch([TOKEN_OK, { body: '<html>' }]);

    const error = await failure(getUserRoles(makeEnv(), 'u1'));
    expect(error.message).toBe('Auth0 Management API returned non-JSON for /users/u1/roles');
    expect(error.status).toBe(502);
    expect(error.body).toBe('<html>');
  });
});

describe('listUsersWithRoles', () => {
  test('maps each member to their role and lets admin win over viewer', async () => {
    mockFetch([
      TOKEN_OK,
      ROLES_OK,
      {
        body: {
          users: [{ user_id: 'auth0|1' }, { user_id: 'auth0|2' }, { user_id: 'auth0|3' }],
          total: 3,
        },
      },
      { body: { users: [{ user_id: 'auth0|1' }, { user_id: 'auth0|2' }], total: 2 } },
      { body: { users: [{ user_id: 'auth0|2' }], total: 1 } },
    ]);

    const { users, roleByUserId } = await listUsersWithRoles(makeEnv());

    expect(users.map((u) => u.user_id)).toEqual(['auth0|1', 'auth0|2', 'auth0|3']);
    expect([...roleByUserId]).toEqual([
      ['auth0|1', 'viewer'],
      ['auth0|2', 'admin'],
    ]);
    expect(calls.slice(3).map((c) => c.url.split('?')[0])).toEqual([
      'https://tenant.auth0.com/api/v2/roles/rol_viewer/users',
      'https://tenant.auth0.com/api/v2/roles/rol_admin/users',
    ]);
  });
});

describe('setUserRole', () => {
  test('assigns the target role then removes the other one', async () => {
    mockFetch([TOKEN_OK, ROLES_OK, { body: {} }, { body: {} }]);

    await setUserRole(makeEnv(), 'auth0|1', 'admin');

    const mutations = calls.filter((c) => c.method === 'POST' || c.method === 'DELETE');
    const assign = mutations.find((c) => c.method === 'POST' && c.url.includes('/roles'));
    const remove = mutations.find((c) => c.method === 'DELETE');

    expect(sent(assign)).toEqual({ roles: ['rol_admin'] });
    expect(sent(remove)).toEqual({ roles: ['rol_viewer'] });
    // Assign must precede remove, so a mid-way failure leaves access rather than lockout.
    expect(assign && remove && mutations.indexOf(assign)).toBeLessThan(
      remove ? mutations.indexOf(remove) : -1,
    );
  });

  test('works in the viewer direction too', async () => {
    mockFetch([TOKEN_OK, ROLES_OK, { body: {} }, { body: {} }]);

    await setUserRole(makeEnv(), 'auth0|1', 'viewer');
    const assign = calls.find((c) => c.method === 'POST' && c.url.includes('/roles'));
    expect(sent(assign)).toEqual({ roles: ['rol_viewer'] });
  });

  test('accepts an empty success body from the Management API', async () => {
    mockFetch([TOKEN_OK, ROLES_OK, { body: '' }]);

    await setUserRole(makeEnv(), 'auth0|1', 'admin');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST', 'DELETE']);
  });

  // No arbitrary role injection, even before the handler's own allow-list.
  test('rejects a role outside the known set', async () => {
    mockFetch([TOKEN_OK, ROLES_OK]);

    for (const bad of ['superadmin', 'sms', '', 'ADMIN']) {
      expect((await failure(setUserRole(makeEnv(), 'auth0|1', bad))).message).toMatch(
        /Unknown role/,
      );
    }
  });
});

describe('assignRoleByName / removeRolesByName', () => {
  test('assignRoleByName rejects a role the tenant lacks with a 400', async () => {
    mockFetch([TOKEN_OK, ROLES_OK]);

    const error = await failure(assignRoleByName(makeEnv(), 'auth0|1', 'sms'));
    expect(error.message).toBe("Unknown role 'sms'");
    expect(error.status).toBe(400);
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/api/v2'))).toHaveLength(0);
  });

  test('removeRolesByName does nothing for no names or for names without an id', async () => {
    mockFetch([TOKEN_OK, ROLES_OK]);
    const env = makeEnv();

    await removeRolesByName(env, 'auth0|1', []);
    expect(calls).toHaveLength(0);

    await removeRolesByName(env, 'auth0|1', ['sms']);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  test('removeRolesByName sends the ids of the roles it knows', async () => {
    mockFetch([TOKEN_OK, ROLES_OK, { body: {} }]);

    await removeRolesByName(makeEnv(), 'auth0|1', ['viewer', 'sms']);
    expect(sent(calls.find((c) => c.method === 'DELETE'))).toEqual({ roles: ['rol_viewer'] });
  });
});
