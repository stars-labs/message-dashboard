// Run with: bun test server/handlers/users.test.ts
//
// PUT /api/users/:id/role is a privilege-escalation primitive. These tests pin its
// guards: role allow-list, self-change refusal, audit logging, session revocation.
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { ORPCError } from '@orpc/server';
import { parseJson } from '../../shared/parse-json.js';
import type { D1RunResult, D1Statement } from '../lib/d1.js';
import { usersHandler } from './users.js';

type SetRoleRequest = Parameters<typeof usersHandler.setRole>[0];
type ListRequest = Parameters<typeof usersHandler.list>[0];

let fetchSpy: Mock<typeof fetch>;
let errorSpy: Mock<typeof console.error>;
let calls: { url: string; method: string; body: unknown }[];
let audit: unknown[][];

function kvStub(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

// Records the centralized audit_logs bind() parameters so we can assert on them.
function dbStub() {
  const run: D1RunResult = { meta: { changes: 1, last_row_id: 1 } };
  const prepare = (): D1Statement<'run'> => ({
    bind: (...params) => ({
      bind: () => {
        throw new Error('bind is called once');
      },
      run: () => {
        audit.push(params);
        return Promise.resolve(run);
      },
    }),
    run: () => Promise.resolve(run),
  });
  return { prepare };
}

interface Auth0Fixture {
  roles?: string[];
  failOn?: string | null;
  failWith?: { status: number; headers?: Record<string, string> };
  users?: {
    user_id: string;
    email?: string;
    name?: string;
    last_login?: string | null;
    logins_count?: number;
  }[];
  members?: Record<string, string[]>;
  roleNames?: { admin: string; viewer: string };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

// Routes Auth0 Management calls by URL. Check order matters: a role-members URL
// (/roles/{id}/users) contains both "/roles" and "/users".
function mockAuth0({
  roles = ['viewer'],
  failOn = null,
  failWith = { status: 500 },
  users = [
    { user_id: 'auth0|1', email: 'a@poloniex.com', name: 'A', last_login: null, logins_count: 3 },
  ],
  members = { rol_viewer: ['auth0|1'], rol_admin: [] },
  roleNames = { admin: 'admin', viewer: 'viewer' },
}: Auth0Fixture = {}) {
  const respond = (url: string, method: string): Response => {
    if (failOn && url.includes(failOn)) {
      return new Response('upstream boom', failWith);
    }

    if (url.includes('/oauth/token')) {
      return Response.json({ access_token: 't', expires_in: 86400 });
    }

    // Role members — must precede the generic /roles and /users branches.
    const memberMatch = /\/roles\/([^/?]+)\/users/.exec(url);
    if (memberMatch) {
      const list = (members[memberMatch[1] ?? ''] ?? []).map((id) => ({ user_id: id }));
      return Response.json({ users: list, total: list.length, start: 0, limit: 100 });
    }

    if (url.includes('/api/v2/roles')) {
      return Response.json([
        { id: 'rol_admin', name: roleNames.admin },
        { id: 'rol_viewer', name: roleNames.viewer },
      ]);
    }

    // A specific user's roles — used by setRole to record the previous value.
    if (/\/users\/[^/?]+\/roles/.test(url)) {
      if (method === 'GET') return Response.json(roles.map((r) => ({ id: `rol_${r}`, name: r })));
      return new Response('', { status: 204 });
    }

    if (url.includes('/api/v2/users')) {
      return Response.json({ users, total: users.length, start: 0, limit: 100 });
    }

    return new Response('unexpected', { status: 404 });
  };

  fetchSpy.mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body });
        return Promise.resolve(respond(url, method));
      },
      { preconnect: () => undefined },
    ),
  );
}

function baseEnv() {
  return {
    AUTH0_DOMAIN: 'tenant.auth0.com',
    AUTH0_M2M_CLIENT_ID: 'id',
    AUTH0_M2M_CLIENT_SECRET: 'secret',
    SESSIONS: kvStub(),
    DB: dbStub(),
  };
}

function listRequest(env: Partial<ListRequest['env']> = {}): ListRequest {
  return { env: { ...baseEnv(), ...env }, resHeaders: new Headers() };
}

function setRoleRequest(
  overrides: { user?: SetRoleRequest['user']; env?: ReturnType<typeof baseEnv> } = {},
): SetRoleRequest {
  return {
    env: overrides.env ?? baseEnv(),
    user: overrides.user ?? { id: 'auth0|admin', email: 'admin@poloniex.com' },
    resHeaders: new Headers(),
  };
}

/** How a call was refused: the status, code and message the contract handler answers with. */
async function refusal(
  call: Promise<unknown>,
): Promise<{ status: number; code: string; message: string }> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ORPCError)) throw error;
    return { status: error.status, code: String(error.code), message: error.message };
  }
  throw new Error('the call was not refused');
}

const Users = v.object({
  users: v.array(v.object({ id: v.string(), role: v.nullable(v.string()) })),
});

async function usersOf(call: Promise<unknown>) {
  return v.parse(Users, await call).users;
}

beforeEach(() => {
  calls = [];
  audit = [];
  fetchSpy = spyOn(globalThis, 'fetch');
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  fetchSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('GET /api/users', () => {
  test('returns users with their resolved role', async () => {
    mockAuth0({ roles: ['viewer'] });

    expect(await usersHandler.list(listRequest())).toEqual({
      success: true,
      users: [
        {
          id: 'auth0|1',
          email: 'a@poloniex.com',
          name: 'A',
          last_login: null,
          logins_count: 3,
          roles: ['viewer'],
          role: 'viewer',
        },
      ],
      known_roles: ['admin', 'viewer'],
      admin_role: 'admin',
      viewer_role: 'viewer',
    });
  });

  test('reports null role for a user holding neither role', async () => {
    mockAuth0({ members: { rol_viewer: [], rol_admin: [] } });

    const users = await usersOf(usersHandler.list(listRequest()));
    expect(users[0]?.role).toBeNull();
  });

  test('fills the fields Auth0 left out with null and zero', async () => {
    mockAuth0({ users: [{ user_id: 'auth0|1' }], members: { rol_viewer: [], rol_admin: [] } });

    expect(await usersHandler.list(listRequest())).toMatchObject({
      users: [
        {
          id: 'auth0|1',
          email: null,
          name: null,
          last_login: null,
          logins_count: 0,
          roles: [],
          role: null,
        },
      ],
    });
  });

  test('admin wins when a user somehow holds both roles', async () => {
    mockAuth0({ members: { rol_viewer: ['auth0|1'], rol_admin: ['auth0|1'] } });

    const users = await usersOf(usersHandler.list(listRequest()));
    expect(users[0]?.role).toBe('admin');
  });

  // THE regression test. The first implementation asked Auth0 for each user's roles
  // individually — concurrently, via Promise.all — which returned HTTP 429 as soon as
  // the tenant had more than a handful of users. Cost must not scale with user count.
  test('makes a constant number of Management API calls regardless of user count', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      user_id: `auth0|${String(i)}`,
      email: `u${String(i)}@poloniex.com`,
    }));

    mockAuth0({
      users: many,
      members: { rol_viewer: many.slice(0, 30).map((u) => u.user_id), rol_admin: [] },
    });

    const users = await usersOf(usersHandler.list(listRequest()));
    expect(users).toHaveLength(60);

    // token + roles lookup + user list + 2 role-membership calls. Generous ceiling, but
    // far below the 60+ the per-user version would make.
    expect(calls.length).toBeLessThanOrEqual(8);

    // Explicitly: not one per-user roles call anywhere.
    const perUserRoleCalls = calls.filter((c) => /\/users\/[^/?]+\/roles/.test(c.url));
    expect(perUserRoleCalls).toHaveLength(0);
  });

  test('resolves roles correctly across the membership lists', async () => {
    mockAuth0({
      users: [{ user_id: 'auth0|a' }, { user_id: 'auth0|b' }, { user_id: 'auth0|c' }],
      members: { rol_admin: ['auth0|a'], rol_viewer: ['auth0|b'] },
    });

    const users = await usersOf(usersHandler.list(listRequest()));
    const byId = Object.fromEntries(users.map((u) => [u.id, u.role]));

    expect(byId).toEqual({ 'auth0|a': 'admin', 'auth0|b': 'viewer', 'auth0|c': null });
  });

  // Production uses sms-admin / sms-viewer, not the defaults. The response must carry
  // which configured name means what, or a client comparing against "admin" mislabels
  // every row.
  test('resolves and reports renamed roles', async () => {
    mockAuth0({
      roleNames: { admin: 'sms-admin', viewer: 'sms-viewer' },
      users: [{ user_id: 'auth0|1', email: 'a@poloniex.com' }],
      members: { rol_admin: ['auth0|1'], rol_viewer: [] },
    });

    const req = listRequest({ AUTH0_ADMIN_ROLE: 'sms-admin', AUTH0_VIEWER_ROLE: 'sms-viewer' });

    expect(await usersHandler.list(req)).toMatchObject({
      admin_role: 'sms-admin',
      viewer_role: 'sms-viewer',
      known_roles: ['sms-admin', 'sms-viewer'],
      users: [{ role: 'sms-admin' }],
    });
  });

  // Production uses google-oauth2|... ids, which contain a '|' and must survive the
  // round trip through the URL path.
  test('handles provider-prefixed user ids containing a pipe', async () => {
    const id = 'google-oauth2|110599213519946932722';
    mockAuth0({ users: [{ user_id: id }], members: { rol_admin: [id], rol_viewer: [] } });

    const users = await usersOf(usersHandler.list(listRequest()));
    expect(users[0]).toMatchObject({ id, role: 'admin' });
  });

  test('surfaces a Management API failure as 502, not a fake success', async () => {
    mockAuth0({ failOn: '/api/v2/users' });

    const refused = await refusal(usersHandler.list(listRequest()));
    expect([refused.status, refused.code]).toEqual([502, 'BAD_GATEWAY']);
    expect(refused.message).toStartWith('Auth0 Management API request failed: ');
  });

  test('surfaces a rate-limited Management API as a retryable 503 with its Retry-After', async () => {
    mockAuth0({
      failOn: '/api/v2/users',
      failWith: { status: 429, headers: { 'Retry-After': '30' } },
    });

    const request = listRequest();
    expect(await refusal(usersHandler.list(request))).toEqual({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Auth0 is rate limiting the Management API; try again shortly',
    });
    expect(request.resHeaders.get('Retry-After')).toBe('30');
  });

  test('sends no Retry-After when Auth0 gave none', async () => {
    mockAuth0({ failOn: '/api/v2/users', failWith: { status: 429 } });

    const request = listRequest();
    expect((await refusal(usersHandler.list(request))).status).toBe(503);
    expect(request.resHeaders.has('Retry-After')).toBe(false);
  });

  test('surfaces a malformed users page as 502', async () => {
    fetchSpy.mockImplementation(
      Object.assign(
        (input: string | URL | Request) =>
          Promise.resolve(
            requestUrl(input).includes('/oauth/token')
              ? Response.json({ access_token: 't', expires_in: 86400 })
              : Response.json({ unexpected: true }),
          ),
        { preconnect: () => undefined },
      ),
    );

    expect((await refusal(usersHandler.list(listRequest()))).status).toBe(502);
  });
});

describe('PUT /api/users/:id/role — role allow-list', () => {
  // A role that is not a string never reaches the handler: the contract rejects it.
  for (const role of ['superadmin', 'sms', '', 'ADMIN', 'admin ']) {
    test(`rejects role ${JSON.stringify(role)} with 400`, async () => {
      mockAuth0();

      expect(await refusal(usersHandler.setRole(setRoleRequest(), 'auth0|target', role))).toEqual({
        status: 400,
        code: 'BAD_REQUEST',
        message: 'role must be one of: admin, viewer',
      });
      // Nothing was mutated.
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/roles'))).toBe(false);
    });
  }
});

describe('PUT /api/users/:id/role — self-change guard', () => {
  test('refuses to change your own role, even to the same value', async () => {
    mockAuth0();

    const refused = await refusal(usersHandler.setRole(setRoleRequest(), 'auth0|admin', 'viewer'));

    expect([refused.status, refused.code]).toEqual([403, 'FORBIDDEN']);
    expect(refused.message).toMatch(/your own role/i);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/roles'))).toBe(false);
    expect(audit).toHaveLength(0);
  });

  test('refuses self-promotion to admin', async () => {
    mockAuth0();
    const request = setRoleRequest({ user: { id: 'auth0|self', email: 'v@poloniex.com' } });
    expect((await refusal(usersHandler.setRole(request, 'auth0|self', 'admin'))).status).toBe(403);
  });
});

describe('PUT /api/users/:id/role — success path', () => {
  test('assigns the role, revokes sessions and writes an audit row', async () => {
    mockAuth0({ roles: ['viewer'] });

    const env = baseEnv();
    env.SESSIONS = kvStub({
      'usess:auth0|target': JSON.stringify(['tok-1', 'tok-2']),
      'tok-1': 'session',
      'tok-2': 'session',
    });

    expect(await usersHandler.setRole(setRoleRequest({ env }), 'auth0|target', 'admin')).toEqual({
      success: true,
      user_id: 'auth0|target',
      role: 'admin',
      previous_roles: ['viewer'],
      sessions_revoked: 2,
    });

    // Sessions actually gone — a demotion that leaves the session alive is not a demotion.
    expect(env.SESSIONS.store.has('tok-1')).toBe(false);
    expect(env.SESSIONS.store.has('tok-2')).toBe(false);
    expect(env.SESSIONS.store.has('usess:auth0|target')).toBe(false);

    // Audit row records actor, target and the transition.
    expect(audit).toHaveLength(1);
    expect(audit[0]?.slice(0, 4)).toEqual([
      'role_changed',
      'user',
      'auth0|target',
      'admin@poloniex.com',
    ]);
    const details = parseJson(String(audit[0]?.[4]), v.unknown());
    expect(details).toEqual({
      ok: true,
      value: {
        actor_id: 'auth0|admin',
        target_id: 'auth0|target',
        from: ['viewer'],
        to: 'admin',
        sessions_revoked: 2,
      },
    });
  });

  test('demotion to viewer works the same way', async () => {
    mockAuth0({ roles: ['admin'] });

    expect(await usersHandler.setRole(setRoleRequest(), 'auth0|target', 'viewer')).toMatchObject({
      role: 'viewer',
    });
    expect(String(audit[0]?.[4])).toContain('"to":"viewer"');
  });

  test('a Management API failure returns 502 and writes no audit row', async () => {
    mockAuth0({ roles: ['viewer'], failOn: '/oauth/token' });

    const refused = await refusal(usersHandler.setRole(setRoleRequest(), 'auth0|target', 'admin'));
    expect([refused.status, refused.code]).toEqual([502, 'BAD_GATEWAY']);
    expect(refused.message).toContain('Failed to obtain');
    expect(audit).toHaveLength(0);
  });
});
