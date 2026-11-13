import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { auth0Handler } from '../handlers/auth0.js';
import {
  authorizeRunnerControl,
  hasRunnerScope,
  runnerCanAccessOwner,
  RUNNER_SCOPES,
  type RunnerAuth,
} from './runner-auth.js';

let verifySpy: Mock<typeof auth0Handler.verifyToken> | undefined;

afterEach(() => {
  verifySpy?.mockRestore();
  verifySpy = undefined;
});

function runnerRequest(headers: Record<string, string>) {
  return {
    headers: new Headers(headers),
    env: { API_KEY: 'daemon-key', AUTH0_DOMAIN: 'tenant.example' },
  };
}

describe('authorizeRunnerControl', () => {
  test('accepts the daemon API key as the legacy mode', async () => {
    const auth = await authorizeRunnerControl(
      runnerRequest({ 'X-API-Key': 'daemon-key' }),
      RUNNER_SCOPES.heartbeat,
    );
    expect(auth).toEqual({ authorized: true, authMode: 'legacy_api_key', subject: null });
  });

  test('refuses a request with neither a matching key nor a bearer token', async () => {
    expect(
      await authorizeRunnerControl(runnerRequest({ 'X-API-Key': 'other' }), RUNNER_SCOPES.smsAi),
    ).toEqual({ authorized: false });
    expect(await authorizeRunnerControl(runnerRequest({}), RUNNER_SCOPES.smsAi)).toEqual({
      authorized: false,
    });
    expect(
      await authorizeRunnerControl(
        runnerRequest({ Authorization: 'Bearer ' }),
        RUNNER_SCOPES.smsAi,
      ),
    ).toEqual({ authorized: false });
  });

  test('accepts a verified token that carries the scope and names the device', async () => {
    verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue({
      sub: 'auth0|device',
      scope: `openid ${RUNNER_SCOPES.carrierBrowser}`,
    });
    const auth = await authorizeRunnerControl(
      runnerRequest({ Authorization: 'bearer device-jwt' }),
      RUNNER_SCOPES.carrierBrowser,
    );
    expect(auth).toEqual({ authorized: true, authMode: 'auth0_device', subject: 'auth0|device' });
    expect(verifySpy.mock.calls[0]?.[0]).toBe('device-jwt');
  });

  test('refuses a verified token without the scope', async () => {
    verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue({
      sub: 'auth0|device',
      scope: RUNNER_SCOPES.heartbeat,
    });
    const auth = await authorizeRunnerControl(
      runnerRequest({ Authorization: 'Bearer device-jwt' }),
      RUNNER_SCOPES.smsAi,
    );
    expect(auth).toEqual({ authorized: false });
  });

  test('refuses a token that does not verify', async () => {
    verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue(null);
    const auth = await authorizeRunnerControl(
      runnerRequest({ Authorization: 'Bearer device-jwt' }),
      RUNNER_SCOPES.smsAi,
    );
    expect(auth).toEqual({ authorized: false });
  });

  test('refuses when verification throws', async () => {
    verifySpy = spyOn(auth0Handler, 'verifyToken').mockRejectedValue(new Error('jwks down'));
    const auth = await authorizeRunnerControl(
      runnerRequest({ Authorization: 'Bearer device-jwt' }),
      RUNNER_SCOPES.smsAi,
    );
    expect(auth).toEqual({ authorized: false });
  });
});

describe('runner Auth0 scopes', () => {
  test('accepts only an exact scope attached to an authenticated subject', () => {
    expect(
      hasRunnerScope(
        { sub: 'device-1', scope: `openid ${RUNNER_SCOPES.heartbeat}` },
        RUNNER_SCOPES.heartbeat,
      ),
    ).toBe(true);
    expect(
      hasRunnerScope({ sub: 'device-1', scope: 'balance:runners' }, RUNNER_SCOPES.heartbeat),
    ).toBe(false);
    expect(hasRunnerScope({ scope: RUNNER_SCOPES.heartbeat }, RUNNER_SCOPES.heartbeat)).toBe(false);
  });

  test('supports Auth0 RBAC permissions arrays', () => {
    expect(
      hasRunnerScope({ sub: 'device-1', permissions: [RUNNER_SCOPES.smsAi] }, RUNNER_SCOPES.smsAi),
    ).toBe(true);
    expect(
      hasRunnerScope(
        { sub: 'device-1', permissions: [RUNNER_SCOPES.smsAi] },
        RUNNER_SCOPES.carrierBrowser,
      ),
    ).toBe(false);
  });

  test('grants nothing when a claim has the wrong type', () => {
    const heartbeat = RUNNER_SCOPES.heartbeat;
    expect(
      hasRunnerScope({ sub: 'device-1', scope: heartbeat, permissions: ['x', 7] }, heartbeat),
    ).toBe(false);
    expect(hasRunnerScope({ sub: 'device-1', permissions: [heartbeat], scope: 5 }, heartbeat)).toBe(
      false,
    );
    expect(hasRunnerScope({ sub: 42, scope: heartbeat }, heartbeat)).toBe(false);
    expect(hasRunnerScope(null, heartbeat)).toBe(false);
  });

  test('keeps Auth0 and legacy balance-job ownership separate', () => {
    const alice: RunnerAuth = {
      authorized: true,
      authMode: 'auth0_device',
      subject: 'auth0|alice',
    };
    const bob: RunnerAuth = { authorized: true, authMode: 'auth0_device', subject: 'auth0|bob' };
    const legacy: RunnerAuth = { authorized: true, authMode: 'legacy_api_key', subject: null };

    expect(runnerCanAccessOwner(alice, 'auth0|alice')).toBe(true);
    expect(runnerCanAccessOwner(bob, 'auth0|alice')).toBe(false);
    expect(runnerCanAccessOwner(alice, null)).toBe(false);
    expect(runnerCanAccessOwner(legacy, null)).toBe(true);
    expect(runnerCanAccessOwner(legacy, 'auth0|alice')).toBe(false);
    expect(runnerCanAccessOwner(legacy, undefined)).toBe(true);
    expect(runnerCanAccessOwner({ authorized: false }, null)).toBe(false);
  });
});
