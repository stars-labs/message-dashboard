import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { auth0Handler } from '../handlers/auth0.js';
import { handleAuth0 } from './auth0.js';

const claim = 'https://sexy.itoken.world/roles';

let verifySpy;

afterEach(() => {
  verifySpy?.mockRestore();
  verifySpy = undefined;
});

function makeRequest({
  url = 'https://sexy.itoken.world/api/phones',
  headers = {},
  sessions = {},
}) {
  const deleted = [];
  const request = {
    url,
    headers: new Headers(headers),
    env: {
      API_KEY: 'daemon-key',
      AUTH0_ROLE_NAMESPACE: claim,
      SESSIONS: {
        get: async (key) => {
          const value = sessions[key];
          if (value instanceof Error) throw value;
          return value ?? null;
        },
        delete: async (key) => {
          deleted.push(key);
        },
      },
    },
  };
  return { request, deleted };
}

async function body(response) {
  return await response.json();
}

const session = (overrides = {}) =>
  JSON.stringify({
    user: { id: 'auth0|u1', email: 'u@example.com', provider: 'auth0', roles: ['viewer'] },
    expires_at: Date.now() + 60_000,
    ...overrides,
  });

describe('handleAuth0 control endpoints', () => {
  test('lets a request with the daemon API key through', async () => {
    const { request } = makeRequest({
      url: 'https://sexy.itoken.world/api/control/pending',
      headers: { 'X-API-Key': 'daemon-key' },
    });
    expect(await handleAuth0(request)).toBeUndefined();
  });

  test('rejects a wrong API key with 401', async () => {
    const { request } = makeRequest({
      url: 'https://sexy.itoken.world/api/control/pending',
      headers: { 'X-API-Key': 'other' },
    });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'Unauthorized' });
  });

  test('rejects a missing API key with 401', async () => {
    const { request } = makeRequest({ url: 'https://sexy.itoken.world/api/control/pending' });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
  });
});

describe('handleAuth0 sessions', () => {
  test('answers 401 when no credential is presented', async () => {
    const { request } = makeRequest({});
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'No token provided' });
  });

  test('attaches the user of a live session read from the cookie', async () => {
    const { request } = makeRequest({
      headers: { Cookie: 'auth_token=tok-1' },
      sessions: { 'tok-1': session() },
    });
    expect(await handleAuth0(request)).toBeUndefined();
    expect(request.user).toEqual({
      id: 'auth0|u1',
      email: 'u@example.com',
      provider: 'auth0',
      roles: ['viewer'],
    });
  });

  test('attaches the user of a live session read from the Authorization header', async () => {
    const { request } = makeRequest({
      headers: { Authorization: 'Bearer tok-2' },
      sessions: { 'tok-2': session() },
    });
    expect(await handleAuth0(request)).toBeUndefined();
    expect(request.user?.id).toBe('auth0|u1');
  });

  test('deletes an expired session and answers 401', async () => {
    const { request, deleted } = makeRequest({
      headers: { Cookie: 'auth_token=tok-1' },
      sessions: { 'tok-1': session({ expires_at: Date.now() - 1 }) },
    });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'Session expired' });
    expect(deleted).toEqual(['tok-1']);
    expect(request.user).toBeUndefined();
  });

  test('answers 401 when the stored session is not JSON', async () => {
    const { request } = makeRequest({
      headers: { Cookie: 'auth_token=tok-1' },
      sessions: { 'tok-1': 'not json' },
    });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'Authentication failed' });
  });

  test('answers 401 when the session store fails', async () => {
    const { request } = makeRequest({
      headers: { Cookie: 'auth_token=tok-1' },
      sessions: { 'tok-1': new Error('kv down') },
    });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'Authentication failed' });
  });

  test('answers 401 without attaching a user when the stored session has no user', async () => {
    const { request } = makeRequest({
      headers: { Cookie: 'auth_token=tok-1' },
      sessions: { 'tok-1': JSON.stringify({ expires_at: Date.now() + 60_000 }) },
    });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'Authentication failed' });
    expect(request.user).toBeUndefined();
  });
});

describe('handleAuth0 bearer JWTs', () => {
  test('maps a verified JWT to a user with the namespaced roles', async () => {
    const payload = {
      sub: 'auth0|u2',
      email: 'u2@example.com',
      nickname: 'u2',
      [claim]: ['admin'],
    };
    verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue(payload);
    const { request } = makeRequest({ headers: { Authorization: 'Bearer jwt-1' } });

    expect(await handleAuth0(request)).toBeUndefined();
    expect(request.user).toEqual({
      id: 'auth0|u2',
      email: 'u2@example.com',
      name: 'u2',
      picture: undefined,
      roles: ['admin'],
    });
    expect(request.auth0Token).toEqual(payload);
    expect(verifySpy.mock.calls[0][0]).toBe('jwt-1');
  });

  test('answers 401 when the JWT does not verify', async () => {
    verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue(null);
    const { request } = makeRequest({ headers: { Authorization: 'Bearer jwt-1' } });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'Invalid token' });
  });

  test('answers 401 when a verified JWT has no subject', async () => {
    verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue({ [claim]: ['admin'] });
    const { request } = makeRequest({ headers: { Authorization: 'Bearer jwt-1' } });
    const response = await handleAuth0(request);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'Invalid token' });
    expect(request.user).toBeUndefined();
  });
});
