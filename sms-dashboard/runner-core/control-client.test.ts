import { describe, expect, test } from 'bun:test';
import { createControlClient } from './control-client.js';

describe('runner control client', () => {
  test('uses an API key without exposing it in the URL', async () => {
    const calls: [string, RequestInit][] = [];
    const client = createControlClient({
      baseUrl: 'https://dashboard.example/',
      apiKey: 'local-secret',
      fetchImpl: (url, init) => {
        calls.push([url, init]);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await client.request('/api/jobs?runner_id=desktop-1', {
      method: 'POST',
      body: JSON.stringify({ ready: true }),
    });

    const [url, init] = calls[0] ?? ['', {}];
    const headers = new Headers(init.headers);
    expect(url).toBe('https://dashboard.example/api/jobs?runner_id=desktop-1');
    expect(headers.get('X-API-Key')).toBe('local-secret');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(url).not.toContain('local-secret');
  });

  test('requests a fresh bearer token for each call', async () => {
    let tokenNumber = 0;
    const headers: (string | null)[] = [];
    const client = createControlClient({
      baseUrl: 'https://dashboard.example',
      getAccessToken: () => {
        tokenNumber += 1;
        return Promise.resolve(`token-${tokenNumber}`);
      },
      fetchImpl: (_url, options) => {
        headers.push(new Headers(options.headers).get('Authorization'));
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await client.request('/one');
    await client.request('/two');
    expect(headers).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  test('rejects an unsafe base URL or missing credentials', () => {
    expect(() => createControlClient({ baseUrl: 'file:///tmp/data', apiKey: 'key' })).toThrow();
    expect(() => createControlClient({ baseUrl: 'https://dashboard.example' })).toThrow();
  });
});
