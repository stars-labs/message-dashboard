import { afterEach, describe, expect, test } from 'bun:test';
import { auth0Handler, ensureDashboardLoginRole, resolveLoginRoles } from './auth0.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const claim = 'https://sexy.itoken.world/roles';
const env = {
  AUTH0_AUDIENCE: 'https://sexy.itoken.world/api',
  AUTH0_LOGIN_AUDIENCE: 'https://sexy.itoken.world/login-api',
  AUTH0_CLIENT_ID: 'dashboard-client',
  AUTH0_ROLE_NAMESPACE: claim,
};

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
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const sessionWrites = [];
    const callbackEnv = {
      ...env,
      AUTH0_DOMAIN: 'tenant.example',
      AUTH0_CLIENT_SECRET: 'test-secret',
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => ({ success: true }) }),
        }),
      },
      SESSIONS: {
        get: async () => null,
        put: async (...args) => sessionWrites.push(args),
      },
    };

    const response = await auth0Handler.callback({
      url: 'https://sexy.itoken.world/callback?code=authorization-code',
      env: callbackEnv,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://sexy.itoken.world/');
    expect(sessionWrites).toHaveLength(2);
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
