import { afterEach, describe, expect, test } from 'bun:test';
import { auth0Handler, resolveLoginRoles } from './auth0.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const claim = 'https://sexy.qzz.io/roles';
const env = {
  AUTH0_AUDIENCE: 'https://sexy.qzz.io/api',
  AUTH0_LOGIN_AUDIENCE: 'https://sexy.qzz.io/login-api',
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
      url: 'https://sexy.qzz.io/login',
      env: {
        AUTH0_DOMAIN: 'tenant.example',
        AUTH0_CLIENT_ID: 'dashboard-client',
        AUTH0_AUDIENCE: 'https://sexy.qzz.io/api',
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
      url: 'https://sexy.qzz.io/callback?code=authorization-code',
      env: callbackEnv,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://sexy.qzz.io/');
    expect(sessionWrites).toHaveLength(2);
  });
});
