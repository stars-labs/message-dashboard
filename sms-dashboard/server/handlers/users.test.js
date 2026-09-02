// Run with: bun test server/handlers/users.test.js
//
// PUT /api/users/:id/role is a privilege-escalation primitive. These tests pin its
// guards: role allow-list, self-change refusal, audit logging, session revocation.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { usersHandler } from './users.js';

const realFetch = globalThis.fetch;
let calls;
let audit;

function kvStub(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, options) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return options?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// Records the centralized audit_logs bind() parameters so we can assert on them.
function dbStub() {
  return {
    prepare() {
      return {
        bind(...params) {
          return {
            async run() {
              audit.push(params);
            },
          };
        },
      };
    },
  };
}

// Routes Auth0 Management calls by URL. Check order matters: a role-members URL
// (/roles/{id}/users) contains both "/roles" and "/users".
function mockAuth0({
  roles = ['viewer'],
  failOn = null,
  users = [{ user_id: 'auth0|1', email: 'a@poloniex.com', name: 'A', last_login: null, logins_count: 3 }],
  members = { rol_viewer: ['auth0|1'], rol_admin: [] },
  roleNames = { admin: 'admin', viewer: 'viewer' },
} = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ url: u, method, body: init.body });

    if (failOn && u.includes(failOn)) {
      return new Response('upstream boom', { status: 500 });
    }

    if (u.includes('/oauth/token')) {
      return Response.json({ access_token: 't', expires_in: 86400 });
    }

    // Role members — must precede the generic /roles and /users branches.
    const memberMatch = u.match(/\/roles\/([^/?]+)\/users/);
    if (memberMatch) {
      const list = (members[memberMatch[1]] || []).map((id) => ({ user_id: id }));
      return Response.json({ users: list, total: list.length, start: 0, limit: 100 });
    }

    if (u.includes('/api/v2/roles')) {
      return Response.json([
        { id: 'rol_admin', name: roleNames.admin },
        { id: 'rol_viewer', name: roleNames.viewer },
      ]);
    }

    // A specific user's roles — used by setRole to record the previous value.
    if (u.match(/\/users\/[^/?]+\/roles/)) {
      if (method === 'GET') return Response.json(roles.map((r) => ({ id: `rol_${r}`, name: r })));
      return new Response('', { status: 204 });
    }

    if (u.includes('/api/v2/users')) {
      return Response.json({ users, total: users.length, start: 0, limit: 100 });
    }

    return new Response('unexpected', { status: 404 });
  };
}

function request(overrides = {}) {
  return {
    env: {
      AUTH0_DOMAIN: 'tenant.auth0.com',
      AUTH0_M2M_CLIENT_ID: 'id',
      AUTH0_M2M_CLIENT_SECRET: 'secret',
      SESSIONS: kvStub(),
      DB: dbStub(),
    },
    user: { id: 'auth0|admin', email: 'admin@poloniex.com', roles: ['admin'] },
    params: { id: 'auth0|target' },
    json: async () => ({ role: 'admin' }),
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  audit = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GET /api/users', () => {
  test('returns users with their resolved role', async () => {
    mockAuth0({ roles: ['viewer'] });

    const res = await usersHandler.list(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.users[0]).toMatchObject({ id: 'auth0|1', email: 'a@poloniex.com', role: 'viewer' });
    expect(body.known_roles).toEqual(['admin', 'viewer']);
  });

  test('reports null role for a user holding neither role', async () => {
    mockAuth0({ members: { rol_viewer: [], rol_admin: [] } });

    const body = await (await usersHandler.list(request())).json();
    expect(body.users[0].role).toBeNull();
  });

  test('admin wins when a user somehow holds both roles', async () => {
    mockAuth0({ members: { rol_viewer: ['auth0|1'], rol_admin: ['auth0|1'] } });

    const body = await (await usersHandler.list(request())).json();
    expect(body.users[0].role).toBe('admin');
  });

  // THE regression test. The first implementation asked Auth0 for each user's roles
  // individually — concurrently, via Promise.all — which returned HTTP 429 as soon as
  // the tenant had more than a handful of users. Cost must not scale with user count.
  test('makes a constant number of Management API calls regardless of user count', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      user_id: `auth0|${i}`,
      email: `u${i}@poloniex.com`,
    }));

    mockAuth0({ users: many, members: { rol_viewer: many.slice(0, 30).map((u) => u.user_id), rol_admin: [] } });

    const body = await (await usersHandler.list(request())).json();
    expect(body.users).toHaveLength(60);

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

    const body = await (await usersHandler.list(request())).json();
    const byId = Object.fromEntries(body.users.map((u) => [u.id, u.role]));

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

    const req = request();
    req.env.AUTH0_ADMIN_ROLE = 'sms-admin';
    req.env.AUTH0_VIEWER_ROLE = 'sms-viewer';

    const body = await (await usersHandler.list(req)).json();

    expect(body.admin_role).toBe('sms-admin');
    expect(body.viewer_role).toBe('sms-viewer');
    expect(body.known_roles).toEqual(['sms-admin', 'sms-viewer']);
    expect(body.users[0].role).toBe('sms-admin');
  });

  // Production uses google-oauth2|... ids, which contain a '|' and must survive the
  // round trip through the URL path.
  test('handles provider-prefixed user ids containing a pipe', async () => {
    const id = 'google-oauth2|110599213519946932722';
    mockAuth0({ users: [{ user_id: id }], members: { rol_admin: [id], rol_viewer: [] } });

    const body = await (await usersHandler.list(request())).json();
    expect(body.users[0]).toMatchObject({ id, role: 'admin' });
  });

  test('surfaces a Management API failure as 502, not a fake success', async () => {
    mockAuth0({ failOn: '/api/v2/users' });

    const res = await usersHandler.list(request());
    expect(res.status).toBe(502);
    expect((await res.json()).success).toBe(false);
  });
});

describe('PUT /api/users/:id/role — role allow-list', () => {
  for (const bad of ['superadmin', 'sms', '', 'ADMIN', 'admin ', null, 42, undefined, ['admin']]) {
    test(`rejects role ${JSON.stringify(bad)} with 400`, async () => {
      mockAuth0();

      const res = await usersHandler.setRole(request({ json: async () => ({ role: bad }) }));
      expect(res.status).toBe(400);
      // Nothing was mutated.
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/roles'))).toBe(false);
    });
  }

  test('rejects a non-JSON body', async () => {
    mockAuth0();
    const res = await usersHandler.setRole(
      request({ json: async () => { throw new Error('not json'); } })
    );
    expect(res.status).toBe(400);
  });

  test('rejects a missing user id', async () => {
    mockAuth0();
    const res = await usersHandler.setRole(request({ params: {} }));
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/users/:id/role — self-change guard', () => {
  test('refuses to change your own role, even to the same value', async () => {
    mockAuth0();

    const res = await usersHandler.setRole(
      request({ params: { id: 'auth0|admin' }, json: async () => ({ role: 'viewer' }) })
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/your own role/i);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/roles'))).toBe(false);
    expect(audit).toHaveLength(0);
  });

  test('refuses self-promotion to admin', async () => {
    mockAuth0();
    const res = await usersHandler.setRole(
      request({
        user: { id: 'auth0|self', email: 'v@poloniex.com', roles: ['viewer'] },
        params: { id: 'auth0|self' },
        json: async () => ({ role: 'admin' }),
      })
    );
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/users/:id/role — success path', () => {
  test('assigns the role, revokes sessions and writes an audit row', async () => {
    mockAuth0({ roles: ['viewer'] });

    const req = request();
    req.env.SESSIONS = kvStub({
      'usess:auth0|target': JSON.stringify(['tok-1', 'tok-2']),
      'tok-1': 'session',
      'tok-2': 'session',
    });

    const res = await usersHandler.setRole(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ role: 'admin', previous_roles: ['viewer'], sessions_revoked: 2 });

    // Sessions actually gone — a demotion that leaves the session alive is not a demotion.
    expect(req.env.SESSIONS.store.has('tok-1')).toBe(false);
    expect(req.env.SESSIONS.store.has('tok-2')).toBe(false);
    expect(req.env.SESSIONS.store.has('usess:auth0|target')).toBe(false);

    // Audit row records actor, target and the transition.
    expect(audit).toHaveLength(1);
    expect(audit[0].slice(0, 4)).toEqual([
      'role_changed',
      'user',
      'auth0|target',
      'admin@poloniex.com',
    ]);
    const details = JSON.parse(audit[0][4]);
    expect(details).toMatchObject({
      actor_id: 'auth0|admin',
      target_id: 'auth0|target',
      from: ['viewer'],
      to: 'admin',
      sessions_revoked: 2,
    });
  });

  test('demotion to viewer works the same way', async () => {
    mockAuth0({ roles: ['admin'] });

    const res = await usersHandler.setRole(request({ json: async () => ({ role: 'viewer' }) }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.role).toBe('viewer');
    expect(JSON.parse(audit[0][4]).to).toBe('viewer');
  });

  test('a Management API failure returns 502 and writes no audit row', async () => {
    mockAuth0({ roles: ['viewer'], failOn: '/oauth/token' });

    const res = await usersHandler.setRole(request());
    expect(res.status).toBe(502);
    expect(audit).toHaveLength(0);
  });
});
