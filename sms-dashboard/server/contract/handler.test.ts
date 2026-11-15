import { describe, expect, test } from 'bun:test';
import { traverseContractProcedures } from '@orpc/server';
import * as v from 'valibot';
import { contract } from '../../shared/api/contract/index.js';
import { route, RouteMeta } from '../../shared/api/contract/route.js';
import { memoryKv } from '../../test/memory-kv.js';
import { callWorker, routeTable } from '../../test/worker-harness.js';
import { contractRoutes } from './handler.js';

const ADMIN = 'session-admin';
const VIEWER = 'session-viewer';

function session(roles: string[]): string {
  return JSON.stringify({
    user: { id: `auth0|${roles.join('-')}`, email: 'someone@example.test', roles },
    expires_at: Date.now() + 3_600_000,
  });
}

const bindings = {
  SESSIONS: memoryKv({ [ADMIN]: session(['sms-admin']), [VIEWER]: session(['sms-viewer']) }),
  AUTH0_M2M_CLIENT_ID: 'm2m-client',
  AUTH0_M2M_CLIENT_SECRET: 'm2m-secret',
};

/** Auth0's Management API with an empty tenant. */
function auth0(url: string): Response {
  if (url.endsWith('/oauth/token')) return Response.json({ access_token: 't', expires_in: 86400 });
  if (url.includes('/api/v2/roles?')) {
    return Response.json([
      { id: 'rol_admin', name: 'sms-admin' },
      { id: 'rol_viewer', name: 'sms-viewer' },
    ]);
  }
  return Response.json({ users: [], total: 0, start: 0, limit: 100 });
}

function rateLimited(): Response {
  return new Response('Global limit has been reached', {
    status: 429,
    headers: { 'Retry-After': '2' },
  });
}

function as(token: string, json = true): Record<string, string> {
  return { Cookie: `auth_token=${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

interface Answer {
  status: number;
  contentType: string | null;
  retryAfter: string | null;
  body: unknown;
}

async function answer(response: Response): Promise<Answer> {
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type'),
    retryAfter: response.headers.get('Retry-After'),
    body: await response.json(),
  };
}

function problemOf(status: number, title: string, code: string, detail: string): Answer {
  return {
    status,
    contentType: 'application/problem+json',
    retryAfter: null,
    body: { type: 'about:blank', title, status, detail, code },
  };
}

describe('contract routes', () => {
  test('each say who may call them', () => {
    const undeclared: string[] = [];
    traverseContractProcedures({ router: contract, path: [] }, ({ contract: procedure, path }) => {
      if (!v.is(RouteMeta, procedure['~orpc'].meta)) undeclared.push(path.join('.'));
    });
    expect(undeclared).toEqual([]);
  });

  test('cannot be declared without saying who may call them', () => {
    const undeclared = () =>
      // @ts-expect-error -- route() takes the access first; a route without one must not compile
      route('GET', '/api/undeclared');
    expect(typeof undeclared).toBe('function');
  });

  test('are served first, and listed in the route table', () => {
    expect(routeTable().slice(0, contractRoutes().length)).toEqual(contractRoutes());
    expect(contractRoutes()).toEqual([
      { method: 'POST', path: '/api/control/heartbeat' },
      { method: 'GET', path: '/api/users' },
      { method: 'PUT', path: '/api/users/:id/role' },
    ]);
  });

  test('answer success as JSON, as the Router does', async () => {
    const { response } = await callWorker('GET', '/api/users', {
      headers: as(ADMIN),
      bindings,
      network: auth0,
    });
    expect(await answer(response)).toEqual({
      status: 200,
      contentType: 'application/json;charset=utf-8',
      retryAfter: null,
      body: {
        success: true,
        users: [],
        known_roles: ['sms-admin', 'sms-viewer'],
        admin_role: 'sms-admin',
        viewer_role: 'sms-viewer',
      },
    });
  });

  test('refuse a caller without the permission as a problem, before Auth0 is asked', async () => {
    const anonymous = await callWorker('GET', '/api/users', { bindings, network: auth0 });
    expect(await answer(anonymous.response)).toEqual(
      problemOf(401, 'Unauthorized', 'UNAUTHORIZED', 'No token provided'),
    );

    const viewer = await callWorker('GET', '/api/users', {
      headers: as(VIEWER),
      bindings,
      network: auth0,
    });
    expect((await answer(viewer.response)).status).toBe(403);
    expect([anonymous.outbound, viewer.outbound]).toEqual([[], []]);
  });

  test('check access before reading the body', async () => {
    const user = await callWorker('PUT', '/api/users/auth0%7Cother/role', {
      headers: { 'Content-Type': 'application/json' },
      body: '{"role":',
      bindings,
    });
    expect(user.response.status).toBe(401);

    const daemon = await callWorker('POST', '/api/control/heartbeat', {
      headers: { 'Content-Type': 'application/json' },
      body: '{"schema_version":',
    });
    expect([daemon.response.status, await daemon.response.json()]).toEqual([
      401,
      { error: 'Unauthorized' },
    ]);
  });

  test('answer a rate-limited Auth0 with 503 and its Retry-After', async () => {
    const { response } = await callWorker('GET', '/api/users', {
      headers: as(ADMIN),
      bindings,
      network: rateLimited,
    });
    expect(await answer(response)).toEqual({
      ...problemOf(
        503,
        'Service Unavailable',
        'SERVICE_UNAVAILABLE',
        'Auth0 is rate limiting the Management API; try again shortly',
      ),
      retryAfter: '2',
    });
  });

  test('answer a body that does not fit the contract with 400, before the handler runs', async () => {
    for (const body of ['{"role":', 'null', '{}', JSON.stringify({ role: 42 })]) {
      const { response, outbound } = await callWorker('PUT', '/api/users/auth0%7Cother/role', {
        headers: as(ADMIN),
        body,
        bindings,
        network: auth0,
      });
      expect([body, response.status, response.headers.get('Content-Type'), outbound]).toEqual([
        body,
        400,
        'application/problem+json',
        [],
      ]);
    }
  });

  // Auth0 ids carry a '|', which the browser sends as %7C; decoding twice, or not
  // at all, addresses the wrong user.
  test('decode a path parameter exactly once', async () => {
    const { outbound } = await callWorker('PUT', '/api/users/auth0%7Cother/role', {
      headers: as(ADMIN),
      body: JSON.stringify({ role: 'sms-viewer' }),
      bindings,
      network: (url) => (url.includes('/roles') ? rateLimited() : auth0(url)),
    });
    expect(outbound.filter((url) => url.includes('/api/v2/users/'))).toEqual([
      'https://tenant.example.test/api/v2/users/auth0%7Cother/roles',
    ]);
  });

  test('answer a body the handler rejects as a problem', async () => {
    const { response } = await callWorker('PUT', '/api/users/auth0%7Cother/role', {
      headers: as(ADMIN),
      body: JSON.stringify({ role: 'root' }),
      bindings,
      network: auth0,
    });
    expect(await answer(response)).toEqual(
      problemOf(400, 'Bad Request', 'BAD_REQUEST', 'role must be one of: sms-admin, sms-viewer'),
    );
  });
});
