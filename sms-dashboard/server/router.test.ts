import { describe, expect, test } from 'bun:test';
import { Router } from './router.js';

interface TestRequest {
  url: string;
  method: string;
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
    router.get('/login', reply('login'));
    router.get('*', reply('shell'));
    router.options('*', reply('preflight'));

    expect(await bodyOf(await router.handle(request('GET', '/login')))).toBe('login');
    expect(await bodyOf(await router.handle(request('GET', '/login/x')))).toBe('shell');
    expect(await bodyOf(await router.handle(request('OPTIONS', '/login')))).toBe('preflight');
    expect(await router.handle(request('POST', '/login'))).toBeNull();
  });

  test('matches a path as a whole, not a prefix', async () => {
    const router = new Router<TestRequest>();
    router.get('/login', reply('login'));

    expect(await router.handle(request('GET', '/login/x'))).toBeNull();
    expect(await router.handle(request('GET', '/log'))).toBeNull();
  });

  test('stops at the first matching route even when it does not answer', async () => {
    const router = new Router<TestRequest>();
    router.get('/x', () => undefined);
    router.get('*', reply('fallback'));

    expect(await router.handle(request('GET', '/x'))).toBeUndefined();
  });

  test('lists its routes by method, each method in registration order', () => {
    const router = new Router<TestRequest>();
    router.options('*', reply('preflight'));
    router.get('/login', reply('login'));
    router.get('*', reply('shell'));

    expect(router.routes()).toEqual([
      { method: 'GET', path: '/login' },
      { method: 'GET', path: '*' },
      { method: 'OPTIONS', path: '*' },
    ]);
  });
});
