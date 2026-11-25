import * as v from 'valibot';
import type { RunnerScope } from '../../shared/api/runner-scopes.js';
import { auth0Handler } from '../handlers/auth0.js';
import { secretMatches } from '../lib/secret.js';

interface RunnerRequest {
  headers: { get(name: string): string | null };
  env: {
    API_KEY?: string;
    AUTH0_DOMAIN?: string;
    AUTH0_AUDIENCE?: string;
    AUTH0_CLIENT_ID?: string;
  };
}

export type RunnerAuth =
  | { authorized: true; authMode: 'legacy_api_key'; subject: null }
  | { authorized: true; authMode: 'auth0_device'; subject: string }
  | { authorized: false };

export type AuthorizedRunner = Extract<RunnerAuth, { authorized: true }>;

const RunnerClaims = v.object({
  sub: v.optional(v.string()),
  scope: v.optional(v.string()),
  permissions: v.optional(v.array(v.string())),
});

function bearerToken(request: RunnerRequest): string | null {
  const authorization = request.headers.get('Authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
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

export function runnerCanAccessOwner(
  auth: RunnerAuth,
  requestedBySubject: string | null | undefined,
): boolean {
  if (!auth.authorized) return false;
  if (auth.authMode === 'auth0_device') {
    return auth.subject.length > 0 && requestedBySubject === auth.subject;
  }
  return requestedBySubject === null || requestedBySubject === undefined;
}

export async function authorizeRunnerControl(
  request: RunnerRequest,
  requiredScope: RunnerScope,
): Promise<RunnerAuth> {
  if (await secretMatches(request.headers.get('X-API-Key'), request.env.API_KEY)) {
    return { authorized: true, authMode: 'legacy_api_key', subject: null };
  }

  const token = bearerToken(request);
  if (token === null) return { authorized: false };

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
