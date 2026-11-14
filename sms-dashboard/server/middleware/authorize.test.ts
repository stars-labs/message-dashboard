import { describe, expect, test } from 'bun:test';
import { authorize, type AuthorizeRequest } from './authorize.js';

function makeRequest(storedSession?: string): AuthorizeRequest {
  return {
    url: 'https://sexy.itoken.world/api/phones',
    headers: new Headers(storedSession === undefined ? {} : { Cookie: 'auth_token=token-1' }),
    env: {
      AUTH0_ROLE_NAMESPACE: 'https://sexy.itoken.world/roles',
      SESSIONS: {
        get: () => Promise.resolve(storedSession ?? null),
        delete: () => Promise.resolve(),
      },
    },
  };
}

function viewerSession(): string {
  return JSON.stringify({
    user: { id: 'auth0|u1', email: 'u@example.com', provider: 'auth0', roles: ['viewer'] },
    expires_at: Date.now() + 60_000,
  });
}

describe('authorize', () => {
  test('lets a signed-in user holding the permission through, with their permissions attached', async () => {
    const request = makeRequest(viewerSession());

    expect(await authorize(request, 'phones.read')).toBeUndefined();
    expect(request.user?.permissions).toContain('phones.read');
  });

  test('answers 401 when nobody is signed in', async () => {
    const response = await authorize(makeRequest(), 'phones.read');

    expect(response?.status).toBe(401);
  });

  test('answers 403 when the signed-in user lacks the permission', async () => {
    const response = await authorize(makeRequest(viewerSession()), 'phones.write');

    expect(response?.status).toBe(403);
  });
});
