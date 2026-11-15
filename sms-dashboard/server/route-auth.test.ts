import { describe, expect, test } from 'bun:test';
import { callWorker, routeTable } from '../test/worker-harness.js';

// Routes that answer without credentials, each with the reason. Every other
// route must refuse an anonymous caller.
const PUBLIC = new Map([
  ['GET /api/live', 'liveness probe'],
  ['GET /api/health', 'uptime monitors: D1 and daemon status, no records'],
  ['GET /favicon.ico', 'redirect to the icon'],
  ['GET /login', 'starts the Auth0 login'],
  ['GET /callback', 'Auth0 returns here before a session exists'],
  ['GET /logout', 'clears the session'],
  ['GET *', 'the app shell gates itself (appShellRedirect) and assets are public'],
  ['OPTIONS *', 'a CORS preflight carries no credentials'],
]);

const routes = routeTable().map(({ method, path }) => ({ method, path, key: `${method} ${path}` }));

function call(method: string, path: string, headers: Record<string, string> = {}) {
  const concrete = path === '*' ? '/some-page' : path.replaceAll(/:[a-z_]+/g, 'x');
  const withBody = method === 'POST' || method === 'PUT';
  return callWorker(method, concrete, {
    headers: withBody ? { 'Content-Type': 'application/json', ...headers } : headers,
    ...(withBody ? { body: '{}' } : {}),
  });
}

describe('who may call each route', () => {
  test('every route outside the public list refuses an anonymous caller with 401', async () => {
    const answered: string[] = [];
    for (const { method, path, key } of routes.filter((route) => !PUBLIC.has(route.key))) {
      const { response } = await call(method, path);
      if (response.status !== 401) answered.push(`${key} -> ${String(response.status)}`);
    }
    expect(answered).toEqual([]);
  });

  test('every daemon and runner route refuses a wrong API key with 401', async () => {
    const answered: string[] = [];
    for (const { method, path, key } of routes.filter((route) =>
      route.path.startsWith('/api/control/'),
    )) {
      const { response } = await call(method, path, { 'X-API-Key': 'not-the-key' });
      if (response.status !== 401) answered.push(`${key} -> ${String(response.status)}`);
    }
    expect(answered).toEqual([]);
  });

  test('the public list names registered routes that do answer anonymously', async () => {
    const registered = new Set(routes.map(({ key }) => key));
    expect([...PUBLIC.keys()].filter((key) => !registered.has(key))).toEqual([]);

    const refused: string[] = [];
    for (const { method, path, key } of routes.filter((route) => PUBLIC.has(route.key))) {
      const { response } = await call(method, path);
      if (response.status === 401 || response.status === 403) refused.push(key);
    }
    expect(refused).toEqual([]);
  });

  test('no anonymous request reaches the network', async () => {
    const reached: string[] = [];
    for (const { method, path, key } of routes) {
      const { outbound } = await call(method, path);
      if (outbound.length > 0) reached.push(`${key} -> ${outbound.join(', ')}`);
    }
    expect(reached).toEqual([]);
  });
});
