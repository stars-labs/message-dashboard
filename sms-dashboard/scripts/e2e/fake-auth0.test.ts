import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { auth0Handler } from '../../server/handlers/auth0.ts';
import {
  getUserRoles,
  listUsersWithRoles,
  removeRolesByName,
  setUserRole,
} from '../../server/utils/auth0-management.ts';
import { memoryKv } from '../../test/memory-kv.ts';
import { ALL_RUNNER_SCOPES } from '../../shared/api/runner-scopes.ts';
import { auth0Origin } from '../../shared/auth0-origin.ts';
import { BROWSER_CLIENT, startFakeAuth0, type FakeAuth0 } from './fake-auth0.ts';

const DeviceCode = v.object({
  device_code: v.string(),
  user_code: v.string(),
  verification_uri_complete: v.string(),
  interval: v.number(),
  expires_in: v.number(),
});
const Tokens = v.object({
  access_token: v.string(),
  refresh_token: v.string(),
  expires_in: v.number(),
});
const AuthError = v.object({ error: v.string() });
const BROWSER_REDIRECT_URI = 'http://localhost:8080/callback';

let tenant: FakeAuth0;
let otherTenant: FakeAuth0;

beforeAll(async () => {
  tenant = await startFakeAuth0(BROWSER_REDIRECT_URI);
  otherTenant = await startFakeAuth0();
});

afterAll(async () => {
  await tenant.stop();
  await otherTenant.stop();
});

function post(path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${auth0Origin(tenant.domain)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

async function deviceLogin(): Promise<v.InferOutput<typeof Tokens>> {
  const begun = await post('/oauth/device/code', {
    client_id: tenant.nativeClientId,
    audience: tenant.audience,
    scope: ['openid', 'offline_access', ...ALL_RUNNER_SCOPES].join(' '),
  });
  expect(begun.status).toBe(200);
  const device = v.parse(DeviceCode, await begun.json());
  const polled = await post('/oauth/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: device.device_code,
    client_id: tenant.nativeClientId,
  });
  expect(polled.status).toBe(200);
  return v.parse(Tokens, await polled.json());
}

function verify(token: string, of: FakeAuth0) {
  return auth0Handler.verifyToken(token, { AUTH0_DOMAIN: of.domain, AUTH0_AUDIENCE: of.audience });
}

describe('fake Auth0 browser login', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  function requestAuthorization(fields: Record<string, string> = {}) {
    const url = new URL(`${auth0Origin(tenant.domain)}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: BROWSER_CLIENT.id,
      redirect_uri: BROWSER_REDIRECT_URI,
      state: 'browser-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...fields,
    }).toString();
    return fetch(url, { redirect: 'manual' });
  }

  async function authorize() {
    const response = await requestAuthorization();
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('Location') ?? '');
    expect(`${callback.origin}${callback.pathname}`).toBe(BROWSER_REDIRECT_URI);
    expect(callback.searchParams.get('state')).toBe('browser-state');
    const code = callback.searchParams.get('code') ?? '';
    expect(code).not.toBe('');
    return code;
  }

  function exchange(code: string, fields: Record<string, string>) {
    return post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: BROWSER_CLIENT.id,
      client_secret: BROWSER_CLIENT.secret,
      code,
      redirect_uri: BROWSER_REDIRECT_URI,
      ...fields,
    });
  }

  test('redeems a code only once with its S256 verifier', async () => {
    const code = await authorize();
    expect((await exchange(code, { code_verifier: verifier })).status).toBe(200);
    const replay = await exchange(code, { code_verifier: verifier });
    expect(replay.status).toBe(400);
    expect(v.parse(AuthError, await replay.json()).error).toBe('invalid_grant');
  });

  test('requires a registered callback and an S256 challenge', async () => {
    const invalidRequests: Record<string, string>[] = [
      { redirect_uri: 'http://localhost:8081/callback' },
      { code_challenge: '' },
      { code_challenge_method: 'plain' },
    ];
    for (const fields of invalidRequests) {
      const response = await requestAuthorization(fields);
      expect(response.status).toBe(400);
      expect(response.headers.has('location')).toBe(false);
      expect(v.parse(AuthError, await response.json()).error).toBe('invalid_request');
    }
  });

  test('requires browser client authentication before exchanging the code', async () => {
    const code = await authorize();
    const response = await exchange(code, { code_verifier: verifier, client_secret: '' });
    expect(response.status).toBe(400);
    expect(v.parse(AuthError, await response.json()).error).toBe('invalid_client');
  });

  test('serves the verified fixture user only with a browser access token', async () => {
    const url = `${auth0Origin(tenant.domain)}/userinfo`;
    expect((await fetch(url)).status).toBe(401);
    const response = await exchange(await authorize(), { code_verifier: verifier });
    const { access_token: token } = v.parse(
      v.object({ access_token: v.string() }),
      await response.json(),
    );
    const userInfo = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(userInfo.status).toBe(200);
    expect(await userInfo.json()).toEqual({
      sub: 'auth0|e2e-admin',
      email: 'admin@example.test',
      name: 'E2E Admin',
      email_verified: true,
    });
  });

  test.each<Record<string, string>>([{}, { code_verifier: 'x'.repeat(43) }])(
    'rejects a code exchange with a missing or incorrect verifier',
    async (fields) => {
      const response = await exchange(await authorize(), fields);
      expect(response.status).toBe(400);
      expect(v.parse(AuthError, await response.json()).error).toBe('invalid_grant');
    },
  );
});

describe('fake Auth0 tenant', () => {
  test('approves a device login with a runner token the Worker accepts', async () => {
    const tokens = await deviceLogin();
    const claims = await verify(tokens.access_token, tenant);
    expect(claims?.['sub']).toBe('auth0|e2e-admin');
    expect(claims?.['aud']).toBe(tenant.audience);
    const granted = String(claims?.['scope']).split(' ');
    expect(ALL_RUNNER_SCOPES.filter((scope) => !granted.includes(scope))).toEqual([]);
  });

  test('signs with its own key, so another tenant does not vouch for it', async () => {
    const tokens = await deviceLogin();
    expect(await verify(tokens.access_token, otherTenant)).toBeNull();
  });

  test('refreshes a token it issued and refuses one it did not', async () => {
    const tokens = await deviceLogin();
    const refreshed = await post('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: tenant.nativeClientId,
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const fresh = v.parse(Tokens, await refreshed.json());
    expect(await verify(fresh.access_token, tenant)).not.toBeNull();

    const unknown = await post('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: tenant.nativeClientId,
      refresh_token: 'never-issued',
    });
    expect(unknown.status).toBe(400);
    expect(v.parse(AuthError, await unknown.json()).error).toBe('invalid_grant');
  });

  test('refuses a device login for another client or API', async () => {
    for (const fields of [
      { client_id: 'someone-else', audience: tenant.audience },
      { client_id: tenant.nativeClientId, audience: 'https://other.example/api' },
    ]) {
      const begun = await post('/oauth/device/code', { ...fields, scope: 'openid' });
      expect(begun.status).toBe(400);
      expect(v.parse(AuthError, await begun.json()).error).toBe('invalid_request');
    }
  });

  test('refuses a grant it does not know and a body it cannot read', async () => {
    const grant = await post('/oauth/token', {
      grant_type: 'password',
      client_id: tenant.nativeClientId,
    });
    expect(grant.status).toBe(400);
    expect(v.parse(AuthError, await grant.json()).error).toBe('unsupported_grant_type');

    const client = await post('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: 'someone-else',
      refresh_token: 'never-issued',
    });
    expect(client.status).toBe(400);
    expect(v.parse(AuthError, await client.json()).error).toBe('invalid_client');

    const unreadable = await fetch(`${auth0Origin(tenant.domain)}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"grant_type":',
    });
    expect(unreadable.status).toBe(400);
    expect(v.parse(AuthError, await unreadable.json()).error).toBe('invalid_request');
    expect((await fetch(`${auth0Origin(tenant.domain)}/nowhere`)).status).toBe(404);
  });

  test('refuses a device code it never issued', async () => {
    const polled = await post('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'never-issued',
      client_id: tenant.nativeClientId,
    });
    expect(polled.status).toBe(400);
    expect(v.parse(AuthError, await polled.json()).error).toBe('invalid_grant');
  });
});

describe('fake Auth0 Management API, as the Worker calls it', () => {
  function managementEnv(of: FakeAuth0) {
    return {
      AUTH0_DOMAIN: of.domain,
      AUTH0_M2M_CLIENT_ID: 'e2e-m2m',
      AUTH0_M2M_CLIENT_SECRET: 'e2e-m2m-secret',
      // wrangler.toml [vars]
      AUTH0_ADMIN_ROLE: 'sms-admin',
      AUTH0_VIEWER_ROLE: 'sms-viewer',
      SESSIONS: memoryKv(),
    };
  }

  test('lists every user with the role they hold', async () => {
    const { users, roleByUserId } = await listUsersWithRoles(managementEnv(tenant));
    expect(users.map((user) => user.user_id)).toEqual(['auth0|e2e-admin', 'auth0|e2e-viewer']);
    expect(Object.fromEntries(roleByUserId)).toEqual({
      'auth0|e2e-admin': 'sms-admin',
      'auth0|e2e-viewer': 'sms-viewer',
    });
  });

  test('moves a user from one role to the other', async () => {
    const fresh = await startFakeAuth0();
    try {
      const env = managementEnv(fresh);
      await setUserRole(env, 'auth0|e2e-viewer', 'sms-admin');
      expect(await getUserRoles(env, 'auth0|e2e-viewer')).toEqual(['sms-admin']);
      await setUserRole(env, 'auth0|e2e-viewer', 'sms-viewer');
      expect(await getUserRoles(env, 'auth0|e2e-viewer')).toEqual(['sms-viewer']);
      await removeRolesByName(env, 'auth0|e2e-viewer', ['sms-viewer']);
      expect(await getUserRoles(env, 'auth0|e2e-viewer')).toEqual([]);
    } finally {
      await fresh.stop();
    }
  });
});
