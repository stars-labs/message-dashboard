import { describe, expect, test } from 'bun:test';
import { matchRoute, Router } from './router.js';

describe('matchRoute', () => {
  test('matches a literal path, the catch-all, and a prefix', () => {
    expect(matchRoute('/api/live', '/api/live')).toEqual({});
    expect(matchRoute('/api/live', '/api/live/x')).toBeNull();
    expect(matchRoute('*', '/anything')).toEqual({});
    expect(matchRoute('/assets/*', '/assets/app.js')).toEqual({});
    expect(matchRoute('/assets/*', '/other/app.js')).toBeNull();
  });

  test('captures and decodes parameters', () => {
    expect(matchRoute('/api/users/:id/role', '/api/users/auth0%7Cabc/role')).toEqual({
      id: 'auth0|abc',
    });
    expect(matchRoute('/api/a/:x/b/:y', '/api/a/1/b/2')).toEqual({ x: '1', y: '2' });
  });

  test('keeps a segment whose encoding is malformed as it arrived', () => {
    expect(matchRoute('/api/users/:id', '/api/users/%E0%A4%A')).toEqual({ id: '%E0%A4%A' });
  });

  test('needs every literal segment and the same number of segments', () => {
    expect(matchRoute('/api/users/:id', '/api/groups/1')).toBeNull();
    expect(matchRoute('/api/users/:id', '/api/users/1/role')).toBeNull();
    expect(matchRoute('/api/users/:id', '/api/users')).toBeNull();
  });
});

interface TestRequest {
  url: string;
  method: string;
  params?: Record<string, string>;
}

function request(method: string, path: string): TestRequest {
  return { url: `https://example.com${path}`, method };
}

function reply(body: string) {
  return () => new Response(body);
}

async function bodyOf(response: Response | null | undefined): Promise<string | null> {
  return response ? response.text() : null;
}

describe('Router', () => {
  test('dispatches on the method and the first matching path', async () => {
    const router = new Router<TestRequest>();
    router.get('/api/live', reply('live'));
    router.get('/api/*', reply('api'));
    router.post('/api/live', reply('post'));

    expect(await bodyOf(await router.handle(request('GET', '/api/live')))).toBe('live');
    expect(await bodyOf(await router.handle(request('GET', '/api/other')))).toBe('api');
    expect(await bodyOf(await router.handle(request('POST', '/api/live')))).toBe('post');
    expect(await router.handle(request('PUT', '/api/live'))).toBeNull();
    expect(await router.handle(request('PATCH', '/api/live'))).toBeNull();
  });

  test('runs a route’s handlers until one responds, and stops at the first matching route', async () => {
    const router = new Router<TestRequest>();
    const seen: string[] = [];
    router.get(
      '/api/x',
      () => {
        seen.push('gate');
        return null;
      },
      () => {
        seen.push('handler');
        return new Response('x');
      },
      () => {
        seen.push('unreached');
        return new Response('y');
      },
    );
    router.get('/api/x', reply('second route'));

    expect(await bodyOf(await router.handle(request('GET', '/api/x')))).toBe('x');
    expect(seen).toEqual(['gate', 'handler']);
  });

  test('answers nothing when the matching route’s handlers all pass', async () => {
    const router = new Router<TestRequest>();
    router.get('/api/x', () => undefined);
    router.get('*', reply('fallback'));

    expect(await router.handle(request('GET', '/api/x'))).toBeUndefined();
  });

  test('sets the decoded parameters only for a parameterised route', async () => {
    const router = new Router<TestRequest>();
    const params: (Record<string, string> | undefined)[] = [];
    const record = (req: TestRequest) => {
      params.push(req.params);
      return new Response('ok');
    };
    router.get('/api/users/:id', record);
    router.get('/api/live', record);

    await router.handle(request('GET', '/api/users/auth0%7Cabc'));
    await router.handle(request('GET', '/api/live'));

    expect(params).toEqual([{ id: 'auth0|abc' }, undefined]);
  });
});
