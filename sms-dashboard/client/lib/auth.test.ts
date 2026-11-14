import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { auth } from './auth.js';

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

beforeEach(() => {
  auth.baseUrl = 'https://example.com';
  auth.user = null;
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
  auth.user = null;
});

function answer(response: () => Response): void {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => Promise.resolve(response()), { preconnect: () => undefined }),
  );
}

const user = {
  id: 'auth0|u1',
  email: 'u@example.com',
  roles: ['viewer'],
  permissions: ['messages.read'],
};

describe('auth.getUser', () => {
  test('returns and remembers the signed-in user', async () => {
    answer(() => Response.json({ success: true, user }));

    expect(await auth.getUser()).toEqual(user);
    expect(auth.user).toEqual(user);
    expect(auth.isAuthenticated()).toBe(true);
  });

  test('returns no user when the session is missing or refused', async () => {
    for (const status of [401, 403]) {
      answer(() => Response.json({ error: 'Unauthorized' }, { status }));
      expect(await auth.getUser()).toBeNull();
      expect(auth.isAuthenticated()).toBe(false);
    }
  });

  test('fails rather than signing out when the identity service fails', async () => {
    answer(() => Response.json({ error: 'down' }, { status: 503 }));

    const error = await auth.getUser().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error instanceof Error ? error.message : null).toBe('身份服务返回 503');
    expect(auth.user).toBeNull();
  });

  test('fails on an answer that is not a user', async () => {
    answer(() => Response.json({ success: true, user: { roles: [] } }));

    const error = await auth.getUser().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error instanceof Error ? error.message : '').toStartWith('身份服务响应格式不符');
    expect(auth.user).toBeNull();
  });
});
