import { describe, expect, test } from 'bun:test';
import { failureOf } from '../test-support/failure-of.js';
import { createAuth0DeviceClient, RUNNER_SCOPES } from './auth0-device.js';

describe('Auth0 device client', () => {
  test('requests only the runner and identity scopes', async () => {
    let request: { url: string; body: URLSearchParams } | undefined;
    const client = createAuth0DeviceClient({
      issuer: 'https://tenant.example',
      clientId: 'native-client',
      audience: 'https://dashboard.example/api',
      fetchImpl: (url, init) => {
        request = {
          url,
          body: init.body instanceof URLSearchParams ? init.body : new URLSearchParams(),
        };
        return Promise.resolve(
          Response.json({ device_code: 'device', user_code: 'ABCD', expires_in: 900 }),
        );
      },
    });
    await client.begin();
    const fields = request?.body;
    expect(request?.url).toBe('https://tenant.example/oauth/device/code');
    expect(fields?.get('scope')).toBe(RUNNER_SCOPES.join(' '));
    expect(fields?.get('client_secret')).toBe(null);
  });

  test('waits through authorization_pending and returns tokens', async () => {
    const replies = [
      new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 403 }),
      Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
    ];
    let pending = 0;
    const client = createAuth0DeviceClient({
      issuer: 'https://tenant.example',
      clientId: 'native-client',
      audience: 'audience',
      fetchImpl: () => Promise.resolve(replies.shift() ?? new Response(null, { status: 500 })),
      sleep: () => Promise.resolve(),
    });
    const token = await client.poll(
      { device_code: 'device', expires_in: 60, interval: 1 },
      {
        onPending: () => {
          pending += 1;
        },
      },
    );
    expect(token.access_token).toBe('access');
    expect(pending).toBe(1);
  });

  test('surfaces Auth0 device authorization errors without exposing request fields', async () => {
    const client = createAuth0DeviceClient({
      issuer: 'https://tenant.example',
      clientId: 'native-client',
      audience: 'audience',
      fetchImpl: () =>
        Promise.resolve(
          Response.json(
            {
              error: 'unauthorized_client',
              error_description: 'Grant type is not enabled for this application.',
            },
            { status: 400 },
          ),
        ),
    });

    expect(await failureOf(client.begin())).toContain(
      'unauthorized_client: Grant type is not enabled for this application.',
    );
  });
});
