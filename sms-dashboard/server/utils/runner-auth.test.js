import { describe, expect, test } from 'bun:test';
import {
  hasRunnerScope,
  runnerCanAccessOwner,
  RUNNER_SCOPES,
} from './runner-auth.js';

describe('runner Auth0 scopes', () => {
  test('accepts only an exact scope attached to an authenticated subject', () => {
    expect(hasRunnerScope({ sub: 'device-1', scope: `openid ${RUNNER_SCOPES.heartbeat}` }, RUNNER_SCOPES.heartbeat))
      .toBe(true);
    expect(hasRunnerScope({ sub: 'device-1', scope: 'balance:runners' }, RUNNER_SCOPES.heartbeat))
      .toBe(false);
    expect(hasRunnerScope({ scope: RUNNER_SCOPES.heartbeat }, RUNNER_SCOPES.heartbeat))
      .toBe(false);
  });

  test('supports Auth0 RBAC permissions arrays', () => {
    expect(hasRunnerScope({ sub: 'device-1', permissions: [RUNNER_SCOPES.smsAi] }, RUNNER_SCOPES.smsAi))
      .toBe(true);
    expect(hasRunnerScope({ sub: 'device-1', permissions: [RUNNER_SCOPES.smsAi] }, RUNNER_SCOPES.unicomBrowser))
      .toBe(false);
  });

  test('keeps Auth0 and legacy balance-job ownership separate', () => {
    const alice = { authorized: true, authMode: 'auth0_device', subject: 'auth0|alice' };
    const bob = { authorized: true, authMode: 'auth0_device', subject: 'auth0|bob' };
    const legacy = { authorized: true, authMode: 'legacy_api_key', subject: null };

    expect(runnerCanAccessOwner(alice, 'auth0|alice')).toBe(true);
    expect(runnerCanAccessOwner(bob, 'auth0|alice')).toBe(false);
    expect(runnerCanAccessOwner(alice, null)).toBe(false);
    expect(runnerCanAccessOwner(legacy, null)).toBe(true);
    expect(runnerCanAccessOwner(legacy, 'auth0|alice')).toBe(false);
  });
});
