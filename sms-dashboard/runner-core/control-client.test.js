import { describe, expect, test } from 'bun:test';
import { createControlClient } from './control-client.js';

describe('runner control client', () => {
  test('uses an API key without exposing it in the URL', async () => {
    const calls = [];
    const client = createControlClient({
      baseUrl: 'https://dashboard.example/',
      apiKey: 'local-secret',
      fetchImpl: async (...args) => {
        calls.push(args);
        return new Response(null, { status: 204 });
      },
    });

    await client.request('/api/jobs?runner_id=desktop-1', {
      method: 'POST',
      body: JSON.stringify({ ready: true }),
    });

    expect(calls[0][0]).toBe('https://dashboard.example/api/jobs?runner_id=desktop-1');
    expect(calls[0][1].headers['X-API-Key']).toBe('local-secret');
    expect(calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(calls[0][0]).not.toContain('local-secret');
  });

  test('requests a fresh bearer token for each call', async () => {
    let tokenNumber = 0;
    const headers = [];
    const client = createControlClient({
      baseUrl: 'https://dashboard.example',
      getAccessToken: async () => `token-${++tokenNumber}`,
      fetchImpl: async (_url, options) => {
        headers.push(options.headers);
        return new Response(null, { status: 204 });
      },
    });

    await client.request('/one');
    await client.request('/two');
    expect(headers.map((value) => value.Authorization))
      .toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  test('rejects an unsafe base URL or missing credentials', () => {
    expect(() => createControlClient({ baseUrl: 'file:///tmp/data', apiKey: 'key' })).toThrow();
    expect(() => createControlClient({ baseUrl: 'https://dashboard.example' })).toThrow();
  });
});
