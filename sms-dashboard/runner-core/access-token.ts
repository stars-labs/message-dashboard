import * as v from 'valibot';
import { parseJson } from '../shared/parse-json.js';

const REQUIRED_RUNNER_SCOPES = Object.freeze([
  'balance:runners:heartbeat',
  'balance:skills:run',
  'balance:browser:run',
]);

const TokenPayload = v.looseObject({
  aud: v.optional(v.unknown()),
  scope: v.optional(v.unknown()),
  permissions: v.optional(v.unknown()),
});

type TokenPayload = v.InferOutput<typeof TokenPayload>;

const UnknownList = v.array(v.unknown());

function decodePayload(token: unknown): TokenPayload | null {
  if (typeof token !== 'string') return null;
  const encoded = token.split('.')[1];
  if (!encoded) return null;
  const payload = parseJson(Buffer.from(encoded, 'base64url').toString('utf8'), TokenPayload);
  return payload.ok ? payload.value : null;
}

export function assertRunnerAccessToken(token: unknown, expectedAudience: string): TokenPayload {
  const payload = decodePayload(token);
  if (!payload) throw new Error('Auth0 returned an unreadable access token');

  const audiences = v.is(UnknownList, payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectedAudience)) {
    throw new Error('Auth0 access token audience does not match the Dashboard API');
  }

  const granted = new Set<unknown>([
    ...(typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : []),
    ...(v.is(UnknownList, payload.permissions) ? payload.permissions : []),
  ]);
  const missing = REQUIRED_RUNNER_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw new Error(`Auth0 access token is missing runner permissions: ${missing.join(', ')}`);
  }
  return payload;
}

export { REQUIRED_RUNNER_SCOPES };
