import { describe, expect, test } from 'bun:test';
import { createAuthSession } from './auth-session.js';
import { REQUIRED_RUNNER_SCOPES } from './access-token.js';

function token(audience = 'dashboard-api') {
  const payload = {
    aud: audience,
    permissions: REQUIRED_RUNNER_SCOPES,
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function memoryStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) { return values[key] || null; },
    async set(key, value) {
      if (value == null) delete values[key];
      else values[key] = value;
    },
  };
}

const configuration = {
  auth0Issuer: 'https://tenant.example',
  auth0ClientId: 'native-client',
  auth0Audience: 'dashboard-api',
};

describe('runner authentication session', () => {
  test('refreshes an existing login and caches the access token', async () => {
    const secureStore = memoryStore({ auth0RefreshToken: 'refresh-1' });
    let requests = 0;
    const session = createAuthSession({
      getConfiguration: () => configuration,
      secureStore,
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ access_token: token(), expires_in: 3600 });
      },
    });

    expect(await session.getAccessToken()).toBe(token());
    expect(await session.getAccessToken()).toBe(token());
    expect(requests).toBe(1);
  });

  test('stores only the refresh token returned by device login', async () => {
    const secureStore = memoryStore();
    const responses = [
      Response.json({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://tenant.example/activate',
        expires_in: 900,
        interval: 1,
      }),
      Response.json({
        access_token: token(),
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }),
    ];
    let displayed;
    const session = createAuthSession({
      getConfiguration: () => configuration,
      secureStore,
      fetchImpl: async () => responses.shift(),
      sleep: async () => {},
    });

    await session.signIn({
      onDeviceCode: (device) => { displayed = device; },
    });

    expect(displayed).toEqual({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://tenant.example/activate',
      verificationUriComplete: undefined,
    });
    expect(secureStore.values).toEqual({ auth0RefreshToken: 'refresh-2' });
  });

  test('clears local authentication on sign out', async () => {
    const secureStore = memoryStore({ auth0RefreshToken: 'refresh-1' });
    const session = createAuthSession({
      getConfiguration: () => configuration,
      secureStore,
    });
    await session.signOut();
    expect(await session.hasRefreshToken()).toBe(false);
  });
});
