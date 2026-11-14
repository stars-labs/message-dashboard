import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

await mock.module('./frontend-assets.js', () => ({
  FRONTEND_ASSETS: { 'index.html': { content: '<!doctype html>', type: 'text/html' } },
}));

const { default: worker } = await import('./index.ts');

let sessions;
let logs;

beforeEach(() => {
  sessions = new Map();
  logs = [
    spyOn(console, 'log').mockImplementation(() => {}),
    spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const log of logs) log.mockRestore();
});

function openApp(token) {
  return worker.fetch(
    new Request('https://sexy.itoken.world/', {
      headers: token ? { Cookie: `auth_token=${token}` } : {},
    }),
    {
      SESSIONS: {
        get: async (key) => sessions.get(key) ?? null,
        delete: async (key) => {
          sessions.delete(key);
        },
      },
    },
    { waitUntil() {} },
  );
}

describe('the app shell session gate', () => {
  test('serves the app to a signed-in user with a dashboard role', async () => {
    sessions.set(
      'token-1',
      JSON.stringify({
        user: { id: 'auth0|a', roles: ['viewer'] },
        expires_at: Date.now() + 60_000,
      }),
    );
    const response = await openApp('token-1');
    expect(response.status).toBe(200);
  });

  test('sends a stored session that is not a valid session back to login', async () => {
    for (const stored of ['not json', JSON.stringify({ expires_at: Date.now() + 60_000 })]) {
      sessions.set('token-1', stored);
      const response = await openApp('token-1');
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://sexy.itoken.world/login');
    }
  });
});
