import { beforeEach, describe, expect, test } from 'bun:test';
import { appShellRedirect } from './frontend-gate.js';

const ORIGIN = 'https://sexy.itoken.world';

let sessions: Map<string, string>;

beforeEach(() => {
  sessions = new Map();
});

const env = {
  SESSIONS: {
    get: (key: string) => Promise.resolve(sessions.get(key) ?? null),
    delete: (key: string) => {
      sessions.delete(key);
      return Promise.resolve();
    },
  },
};

function open(path: string, token?: string) {
  return appShellRedirect(
    {
      url: `${ORIGIN}${path}`,
      headers: new Headers(token === undefined ? {} : { Cookie: `auth_token=${token}` }),
    },
    env,
  );
}

function session(roles: string[], expiresIn = 60_000): string {
  return JSON.stringify({ user: { id: 'auth0|a', roles }, expires_at: Date.now() + expiresIn });
}

function location(response: Response | null): string | null {
  return response?.headers.get('Location') ?? null;
}

describe('the app shell session gate', () => {
  test('serves the app shell to a live session with a dashboard role', async () => {
    sessions.set('token-1', session(['viewer']));

    expect(await open('/', 'token-1')).toBeNull();
    expect(await open('/index.html', 'token-1')).toBeNull();
  });

  test('serves every other path without a session', async () => {
    expect(await open('/assets/app.js')).toBeNull();
    expect(await open('/favicon-32.png')).toBeNull();
  });

  test('sends a browser without a session cookie, or with an unknown one, to login', async () => {
    const missing = await open('/');
    expect(missing?.status).toBe(302);
    expect(location(missing)).toBe(`${ORIGIN}/login`);

    expect(location(await open('/', 'unknown'))).toBe(`${ORIGIN}/login`);
  });

  test('sends a stored session that is not a valid session back to login', async () => {
    for (const stored of ['not json', JSON.stringify({ expires_at: Date.now() + 60_000 })]) {
      sessions.set('token-1', stored);
      expect(location(await open('/', 'token-1'))).toBe(`${ORIGIN}/login`);
    }
  });

  test('deletes an expired session and sends the browser to login', async () => {
    sessions.set('token-1', session(['viewer'], -1));

    expect(location(await open('/', 'token-1'))).toBe(`${ORIGIN}/login`);
    expect(sessions.has('token-1')).toBe(false);
  });

  test('tells a user without a dashboard role why they were sent to login', async () => {
    sessions.set('token-1', session(['billing']));

    expect(location(await open('/', 'token-1'))).toBe(`${ORIGIN}/login?error=no_role`);
    expect(sessions.has('token-1')).toBe(true);
  });
});
