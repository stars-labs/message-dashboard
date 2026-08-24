import { auth0Handler } from '../handlers/auth0.js';

export const RUNNER_SCOPES = Object.freeze({
  heartbeat: 'balance:runners:heartbeat',
  smsAi: 'balance:skills:run',
  carrierBrowser: 'balance:browser:run',
});

function bearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function tokenScopes(payload) {
  const values = [];
  if (typeof payload?.scope === 'string') values.push(...payload.scope.split(/\s+/));
  if (Array.isArray(payload?.permissions)) values.push(...payload.permissions);
  return new Set(values.filter((value) => typeof value === 'string' && value));
}

export function hasRunnerScope(payload, requiredScope) {
  return Boolean(payload?.sub && tokenScopes(payload).has(requiredScope));
}

export function runnerCanAccessOwner(auth, requestedBySubject) {
  if (!auth?.authorized) return false;
  if (auth.authMode === 'auth0_device') {
    return typeof auth.subject === 'string'
      && auth.subject.length > 0
      && requestedBySubject === auth.subject;
  }
  return auth.authMode === 'legacy_api_key' && requestedBySubject == null;
}

export async function authorizeRunnerControl(request, requiredScope) {
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey && apiKey === request.env.API_KEY) {
    return { authorized: true, authMode: 'legacy_api_key', subject: null };
  }

  const token = bearerToken(request);
  if (!token) return { authorized: false };

  try {
    const payload = await auth0Handler.verifyToken(token, request.env);
    if (!hasRunnerScope(payload, requiredScope)) {
      return { authorized: false };
    }
    return { authorized: true, authMode: 'auth0_device', subject: payload.sub };
  } catch {
    return { authorized: false };
  }
}
