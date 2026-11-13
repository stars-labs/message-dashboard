import * as v from 'valibot';
import { auth0Handler } from '../handlers/auth0.js';
import type { AppRequest } from '../worker-context.js';

export const RUNNER_SCOPES = Object.freeze({
  heartbeat: 'balance:runners:heartbeat',
  smsAi: 'balance:skills:run',
  carrierBrowser: 'balance:browser:run',
} as const);

export type RunnerScope = (typeof RUNNER_SCOPES)[keyof typeof RUNNER_SCOPES];

/**
 * The result of a runner authorization check. `authorized` is the discriminant, so
 * `authMode` and `subject` can only be read on the success branch — callers used to
 * read them off a failure result and get `undefined`.
 */
export type RunnerAuth =
  | { authorized: true; authMode: 'legacy_api_key'; subject: null }
  | { authorized: true; authMode: 'auth0_device'; subject: string }
  | { authorized: false };

/** The claims of a runner's Auth0 access token: its subject, its OAuth scopes and its RBAC permissions. */
const RunnerClaims = v.object({
  sub: v.optional(v.string()),
  scope: v.optional(v.string()),
  permissions: v.optional(v.array(v.string())),
});

function bearerToken(request: AppRequest): string | null {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/** The token's subject when it has one and carries the scope; claims of the wrong type grant nothing. */
function scopedSubject(payload: unknown, requiredScope: RunnerScope): string | null {
  const claims = v.safeParse(RunnerClaims, payload);
  if (!claims.success) return null;

  const { sub, scope, permissions } = claims.output;
  if (sub === undefined || sub === '') return null;

  const granted = new Set([...(scope?.split(/\s+/) ?? []), ...(permissions ?? [])]);
  return granted.has(requiredScope) ? sub : null;
}

export function hasRunnerScope(payload: unknown, requiredScope: RunnerScope): boolean {
  return scopedSubject(payload, requiredScope) !== null;
}

export function runnerCanAccessOwner(
  auth: RunnerAuth,
  requestedBySubject: string | null | undefined,
): boolean {
  if (!auth.authorized) return false;
  if (auth.authMode === 'auth0_device') {
    return (
      typeof auth.subject === 'string' &&
      auth.subject.length > 0 &&
      requestedBySubject === auth.subject
    );
  }
  return auth.authMode === 'legacy_api_key' && requestedBySubject == null;
}

export async function authorizeRunnerControl(
  request: AppRequest,
  requiredScope: RunnerScope,
): Promise<RunnerAuth> {
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey && apiKey === request.env.API_KEY) {
    return { authorized: true, authMode: 'legacy_api_key', subject: null };
  }

  const token = bearerToken(request);
  if (!token) return { authorized: false };

  try {
    const subject = scopedSubject(
      await auth0Handler.verifyToken(token, request.env),
      requiredScope,
    );
    if (subject === null) return { authorized: false };
    return { authorized: true, authMode: 'auth0_device', subject };
  } catch {
    return { authorized: false };
  }
}
