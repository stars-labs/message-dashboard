import { describe, expect, test } from 'bun:test';
import { createAuthSession, type SecureStore } from './auth-session.js';
import { REQUIRED_RUNNER_SCOPES } from './access-token.js';

function token(audience = 'dashboard-api'): string {
  const payload = {
    aud: audience,
    permissions: REQUIRED_RUNNER_SCOPES,
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function memoryStore(initial: Record<'auth0RefreshToken', string> | null = null) {
  const values = new Map<string, string>(initial ? Object.entries(initial) : []);
  const store: SecureStore & { values: Map<string, string> } = {
    values,
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
      return Promise.resolve();
    },
  };
  return store;
}

function failed(): Response {
  return new Response(null, { status: 500 });
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
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(Response.json({ access_token: token(), expires_in: 3600 }));
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
    let displayed: unknown;
    const session = createAuthSession({
      getConfiguration: () => configuration,
      secureStore,
      fetchImpl: () => Promise.resolve(responses.shift() ?? failed()),
      sleep: () => Promise.resolve(),
    });

    await session.signIn({
      onDeviceCode: (device) => {
        displayed = device;
      },
    });

    expect(displayed).toEqual({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://tenant.example/activate',
      verificationUriComplete: undefined,
    });
    expect(Object.fromEntries(secureStore.values)).toEqual({ auth0RefreshToken: 'refresh-2' });
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
