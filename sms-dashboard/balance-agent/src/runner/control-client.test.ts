import { describe, expect, test } from 'bun:test';
import { ControlError, createControlClient } from './control-client.js';

const HEARTBEAT = {
  runner_id: 'desktop-1',
  session_id: 'session-1',
  display_name: 'Desktop',
  platform: 'darwin',
  version: '1.0.0',
  capabilities: [],
};

describe('runner control client', () => {
  test('sends the API key in a header and the body as JSON', async () => {
    const calls: [string, RequestInit][] = [];
    const client = createControlClient({
      baseUrl: 'https://dashboard.example/',
      apiKey: 'local-secret',
      fetchImpl: (url, init) => {
        calls.push([url, init]);
        return Promise.resolve(Response.json({ success: true, runner_id: 'desktop-1' }));
      },
    });

    await client.balanceRunnerControl.heartbeat(HEARTBEAT);

    const [url, init] = calls[0] ?? ['', {}];
    const headers = new Headers(init.headers);
    expect(init.method).toBe('POST');
    expect(url).toBe('https://dashboard.example/api/control/balance-runners/heartbeat');
    expect(headers.get('X-API-Key')).toBe('local-secret');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(typeof init.body === 'string' ? JSON.parse(init.body) : init.body).toEqual(HEARTBEAT);
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
        return Promise.resolve(Response.json({ success: true }));
      },
    });

    await client.balanceRunnerControl.check();
    await client.balanceRunnerControl.check();
    expect(headers).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  test('puts a claim runner ID in the query and reads an empty claim as 204', async () => {
    const urls: string[] = [];
    const client = createControlClient({
      baseUrl: 'https://dashboard.example',
      apiKey: 'key',
      fetchImpl: (url, init) => {
        urls.push(`${String(init.method)} ${url} ${typeof init.body}`);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    expect(
      await client.balanceSkillJobs.claim({ query: { runner_id: 'desktop 1' } }),
    ).toMatchObject({ status: 204 });
    expect(urls).toEqual([
      'GET https://dashboard.example/api/control/balance-skills/jobs/claim?runner_id=desktop+1 undefined',
    ]);
  });

  test('turns a refusal into a ControlError with its status and body', async () => {
    const client = createControlClient({
      baseUrl: 'https://dashboard.example',
      apiKey: 'key',
      fetchImpl: () => Promise.resolve(Response.json({ error: 'Unauthorized' }, { status: 401 })),
    });

    const refusal = await client.balanceRunnerControl.check().then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ControlError);
    expect(refusal).toMatchObject({ status: 401, body: '{"error":"Unauthorized"}' });
  });

  test('rejects an unsafe base URL or missing credentials', () => {
    expect(() => createControlClient({ baseUrl: 'file:///tmp/data', apiKey: 'key' })).toThrow();
    expect(() => createControlClient({ baseUrl: 'https://dashboard.example' })).toThrow();
  });
});
