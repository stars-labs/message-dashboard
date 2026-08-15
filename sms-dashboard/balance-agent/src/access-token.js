const REQUIRED_RUNNER_SCOPES = Object.freeze([
  'balance:runners:heartbeat',
  'balance:skills:run',
  'balance:browser:run',
]);

function decodePayload(token) {
  if (typeof token !== 'string') return null;
  const encoded = token.split('.')[1];
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function assertRunnerAccessToken(token, expectedAudience) {
  const payload = decodePayload(token);
  if (!payload) throw new Error('Auth0 returned an unreadable access token');

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectedAudience)) {
    throw new Error('Auth0 access token audience does not match the Dashboard API');
  }

  const granted = new Set([
    ...(typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : []),
    ...(Array.isArray(payload.permissions) ? payload.permissions : []),
  ]);
  const missing = REQUIRED_RUNNER_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw new Error(`Auth0 access token is missing runner permissions: ${missing.join(', ')}`);
  }
  return payload;
}

export { REQUIRED_RUNNER_SCOPES };
