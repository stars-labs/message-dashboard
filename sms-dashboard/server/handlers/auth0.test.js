import { afterEach, describe, expect, test } from 'bun:test';
import { auth0Handler, ensureDashboardLoginRole, resolveLoginRoles } from './auth0.js';

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

const claim = 'https://sexy.itoken.world/roles';
const env = {
  AUTH0_AUDIENCE: 'https://sexy.itoken.world/api',
  AUTH0_LOGIN_AUDIENCE: 'https://sexy.itoken.world/login-api',
  AUTH0_CLIENT_ID: 'dashboard-client',
  AUTH0_ROLE_NAMESPACE: claim,
};

function mockSuccessfulAuth(userInfo = {}) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/oauth/token')) {
      return Response.json({ access_token: 'opaque-access-token', id_token: 'id-token' });
    }
    if (String(url).endsWith('/userinfo')) {
      return Response.json({
        sub: 'auth0|user-1',
        email: 'user@example.com',
        email_verified: true,
        [claim]: ['viewer'],
        ...userInfo,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

function callbackRequest({ dbRun, sessionPut } = {}) {
  const waits = [];
  const sessionWrites = [];
  const callbackEnv = {
    ...env,
    AUTH0_DOMAIN: 'tenant.example',
    AUTH0_CLIENT_SECRET: 'test-secret',
    DB: {
      prepare: () => ({
        bind: () => ({
          run: dbRun || (async () => ({ success: true })),
        }),
      }),
    },
    SESSIONS: {
      get: async () => null,
      put: async (...args) => {
        sessionWrites.push(args);
        if (sessionPut) return sessionPut(...args);
      },
      delete: async () => {},
    },
  };

  return {
    request: {
      url: 'https://sexy.itoken.world/callback?code=authorization-code',
      env: callbackEnv,
      ctx: {
        waitUntil(promise) {
          waits.push(promise);
        },
      },
    },
    waits,
    sessionWrites,
  };
}

describe('Auth0 login role token selection', () => {
  test('uses verified API access-token roles when an audience is configured', async () => {
    const calls = [];
    const roles = await resolveLoginRoles({
      userInfo: {},
      tokens: { access_token: 'access', id_token: 'id' },
      env,
      verifyToken: async (token, audience) => {
        calls.push({ token, audience });
        return token === 'access' ? { [claim]: ['admin'] } : null;
      },
    });

    expect(roles).toEqual(['admin']);
    expect(calls).toEqual([{ token: 'access', audience: env.AUTH0_LOGIN_AUDIENCE }]);
  });

  test('verifies the ID token against the dashboard client ID as a fallback', async () => {
    const calls = [];
    const roles = await resolveLoginRoles({
      userInfo: {},
      tokens: { access_token: 'access', id_token: 'id' },
      env,
      verifyToken: async (token, audience) => {
        calls.push({ token, audience });
        return token === 'id' ? { [claim]: ['viewer'] } : null;
      },
    });

    expect(roles).toEqual(['viewer']);
    expect(calls).toEqual([
      { token: 'access', audience: env.AUTH0_LOGIN_AUDIENCE },
      { token: 'id', audience: env.AUTH0_CLIENT_ID },
    ]);
  });

  test('does not verify tokens when userinfo already has trusted roles', async () => {
    const roles = await resolveLoginRoles({
      userInfo: { [claim]: ['admin'] },
      tokens: {},
      env,
      verifyToken: async () => { throw new Error('must not run'); },
    });
    expect(roles).toEqual(['admin']);
  });

  test('does not use the runner API audience for browser login', async () => {
    const response = await auth0Handler.login({
      url: 'https://sexy.itoken.world/login',
      env: {
        AUTH0_DOMAIN: 'tenant.example',
        AUTH0_CLIENT_ID: 'dashboard-client',
        AUTH0_AUDIENCE: 'https://sexy.itoken.world/api',
      },
    });
    const location = new URL(response.headers.get('location'));
    expect(location.searchParams.get('client_id')).toBe('dashboard-client');
    expect(location.searchParams.has('audience')).toBe(false);
  });

  test('completes the callback when userinfo contains a dashboard role', async () => {
    mockSuccessfulAuth();
    const { request, waits, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);
    await Promise.all(waits);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://sexy.itoken.world/');
    expect(sessionWrites).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  test('creates the session when the non-critical D1 login audit hits quota', async () => {
    mockSuccessfulAuth();
    const logs = [];
    console.error = (...args) => logs.push(args);
    const quotaError = new Error(
      "D1_ERROR: Your account has exceeded D1's free tier daily row read limit."
    );
    const { request, waits, sessionWrites } = callbackRequest({
      dbRun: async () => { throw quotaError; },
    });

    const response = await auth0Handler.callback(request);
    await Promise.all(waits);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://sexy.itoken.world/');
    expect(sessionWrites).toHaveLength(2);
    expect(logs.flat().join(' ')).toContain('auth_audit_failed');
    expect(logs.flat().join(' ')).toContain('D1_QUOTA_EXCEEDED');
  });

  test('denies a disallowed email even when the denial audit hits D1 quota', async () => {
    mockSuccessfulAuth({ email_verified: false });
    console.error = () => {};
    const { request, waits, sessionWrites } = callbackRequest({
      dbRun: async () => { throw new Error("exceeded D1's free tier daily row read limit"); },
    });

    const response = await auth0Handler.callback(request);
    await Promise.all(waits);

    expect(response.status).toBe(403);
    expect(sessionWrites).toHaveLength(0);
  });

  test('returns a friendly 503 without a session when KV session creation fails', async () => {
    mockSuccessfulAuth();
    const logs = [];
    console.error = (...args) => logs.push(args);
    const { request } = callbackRequest({
      sessionPut: async () => { throw new Error('sensitive KV provider detail'); },
    });

    const response = await auth0Handler.callback(request);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(body).toContain('Authentication is temporarily unavailable');
    expect(body).not.toContain('sensitive KV provider detail');
    expect(logs.flat().join(' ')).toContain('auth_callback_failed');
  });

  test('does not expose the Auth0 token response body', async () => {
    globalThis.fetch = async () => new Response('sensitive Auth0 provider detail', { status: 401 });
    console.error = () => {};
    const { request } = callbackRequest();

    const response = await auth0Handler.callback(request);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toBe('Authentication failed');
    expect(body).not.toContain('sensitive Auth0 provider detail');
  });

  test('does not reflect an Auth0 callback error description', async () => {
    console.error = () => {};
    const { request } = callbackRequest();
    request.url = 'https://sexy.itoken.world/callback?error=access_denied&error_description=sensitive-provider-detail';

    const response = await auth0Handler.callback(request);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toBe('Authentication failed');
    expect(body).not.toContain('sensitive-provider-detail');
  });
});

describe('Auth0 login role reconciliation', () => {
  const roleEnv = {
    AUTH0_ADMIN_ROLE: 'sms-admin',
    AUTH0_VIEWER_ROLE: 'sms-viewer',
  };

  test('preserves an existing admin when the login token has no role claim', async () => {
    const assignments = [];

    const result = await ensureDashboardLoginRole({
      tokenRoles: [],
      userId: 'auth0|admin',
      env: roleEnv,
      getUserRoles: async () => ['balance-runner', 'sms-admin'],
      setUserRole: async (...args) => assignments.push(args),
    });

    expect(result).toEqual({
      roles: ['balance-runner', 'sms-admin'],
      autoAssignedRole: null,
    });
    expect(assignments).toEqual([]);
  });

  test('auto-assigns viewer only after Auth0 confirms no dashboard role', async () => {
    const assignments = [];

    const result = await ensureDashboardLoginRole({
      tokenRoles: [],
      userId: 'auth0|new-user',
      env: roleEnv,
      getUserRoles: async () => ['balance-runner'],
      setUserRole: async (...args) => assignments.push(args),
    });

    expect(result).toEqual({
      roles: ['balance-runner', 'sms-viewer'],
      autoAssignedRole: 'sms-viewer',
    });
    expect(assignments).toEqual([[roleEnv, 'auth0|new-user', 'sms-viewer']]);
  });

  test('fails closed without changing roles when the Management API lookup fails', async () => {
    const assignments = [];

    await expect(ensureDashboardLoginRole({
      tokenRoles: [],
      userId: 'auth0|admin',
      env: roleEnv,
      getUserRoles: async () => { throw new Error('management unavailable'); },
      setUserRole: async (...args) => assignments.push(args),
    })).rejects.toThrow('management unavailable');

    expect(assignments).toEqual([]);
  });
});
