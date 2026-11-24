import { createRoleConfig, hasAnyRole, type RoleEnv } from '../config/auth0-roles.js';
import { StoredSession } from './handlers/auth0.js';
import { readKvJson, type KV } from './lib/kv.js';
import { readCookie } from './utils/session-token.js';

interface GateRequest {
  url: string;
  headers: { get(name: string): string | null };
}

interface GateEnv extends RoleEnv {
  SESSIONS: KV<'get' | 'delete'>;
}

function redirect(request: GateRequest, path: string): Response {
  return Response.redirect(new URL(path, request.url).toString(), 302);
}

export async function appShellRedirect(
  request: GateRequest,
  env: GateEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== '/' && pathname !== '/index.html') return null;

  const token = readCookie(request.headers.get('Cookie'), 'auth_token');
  if (!token) return redirect(request, '/login');

  // A stored value that is not a session counts as no session, as in the API middleware.
  const stored = await readKvJson(env.SESSIONS, token, StoredSession);
  if (!stored?.ok) return redirect(request, '/login');

  if (stored.value.expires_at < Date.now()) {
    await env.SESSIONS.delete(token);
    return redirect(request, '/login');
  }

  if (!hasAnyRole(stored.value.user.roles, createRoleConfig(env))) {
    return redirect(request, '/login?error=no_role');
  }
  return null;
}
