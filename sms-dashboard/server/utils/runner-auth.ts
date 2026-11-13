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

/** The JWT claims this module reads. */
interface TokenPayload {
  sub?: unknown;
  scope?: unknown;
  permissions?: unknown;
}

function bearerToken(request: AppRequest): string | null {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function tokenScopes(payload: TokenPayload | null | undefined): Set<string> {
  const values: unknown[] = [];
  if (typeof payload?.scope === 'string') values.push(...payload.scope.split(/\s+/));
  if (Array.isArray(payload?.permissions)) values.push(...payload.permissions);
  return new Set(values.filter((value): value is string => typeof value === 'string' && !!value));
}

export function hasRunnerScope(payload: TokenPayload | null | undefined, requiredScope: RunnerScope): boolean {
  return Boolean(payload?.sub && tokenScopes(payload).has(requiredScope));
}

export function runnerCanAccessOwner(
  auth: RunnerAuth,
  requestedBySubject: string | null | undefined,
): boolean {
  if (!auth.authorized) return false;
  if (auth.authMode === 'auth0_device') {
    return typeof auth.subject === 'string'
      && auth.subject.length > 0
      && requestedBySubject === auth.subject;
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
    const payload = (await auth0Handler.verifyToken(token, request.env)) as TokenPayload | null;
    if (!hasRunnerScope(payload, requiredScope)) {
      return { authorized: false };
    }
    return { authorized: true, authMode: 'auth0_device', subject: String(payload?.sub) };
  } catch {
    return { authorized: false };
  }
}