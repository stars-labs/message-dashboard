import { describe, expect, test } from 'bun:test';
import { assertRunnerAccessToken, REQUIRED_RUNNER_SCOPES } from './access-token.js';

function token(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

describe('Balance Agent access-token preflight', () => {
  test('accepts runner scopes from the OAuth scope claim', () => {
    const payload = assertRunnerAccessToken(token({
      aud: 'dashboard-api',
      scope: REQUIRED_RUNNER_SCOPES.join(' '),
    }), 'dashboard-api');
    expect(payload.aud).toBe('dashboard-api');
  });

  test('accepts runner scopes from Auth0 RBAC permissions', () => {
    expect(() => assertRunnerAccessToken(token({
      aud: ['userinfo', 'dashboard-api'],
      permissions: REQUIRED_RUNNER_SCOPES,
    }), 'dashboard-api')).not.toThrow();
  });

  test('reports only missing permission names', () => {
    expect(() => assertRunnerAccessToken(token({
      aud: 'dashboard-api',
      scope: 'openid balance:runners:heartbeat',
    }), 'dashboard-api')).toThrow(
      'Auth0 access token is missing runner permissions: balance:skills:run, balance:browser:run',
    );
  });

  test('rejects the wrong audience and malformed tokens', () => {
    expect(() => assertRunnerAccessToken(token({
      aud: 'another-api',
      permissions: REQUIRED_RUNNER_SCOPES,
    }), 'dashboard-api')).toThrow('audience does not match');
    expect(() => assertRunnerAccessToken('opaque-token', 'dashboard-api'))
      .toThrow('unreadable access token');
  });
});
