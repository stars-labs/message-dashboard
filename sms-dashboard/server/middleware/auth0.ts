import * as v from 'valibot';
import { auth0Handler, StoredSession } from '../handlers/auth0.js';
import type { SessionUser } from '../../shared/api/auth.js';
import { readKvJson, type KV } from '../lib/kv.js';
import { json } from '../lib/response.js';
import { createRoleConfig, rolesFromToken, type RoleEnv } from '../../config/auth0-roles.js';
import { extractSessionToken } from '../utils/session-token.js';

export interface AuthRequest {
  headers: { get(name: string): string | null };
  env: RoleEnv & {
    AUTH0_DOMAIN?: string;
    AUTH0_AUDIENCE?: string;
    AUTH0_CLIENT_ID?: string;
    SESSIONS: KV<'get' | 'delete'>;
  };
  user?: SessionUser;
  auth0Token?: Record<string, unknown>;
}

const JwtClaims = v.object({
  sub: v.string(),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  nickname: v.optional(v.string()),
  picture: v.optional(v.string()),
});

export async function handleAuth0(request: AuthRequest): Promise<Response | undefined> {
  const { env } = request;

  // HttpOnly auth_token cookie for browsers, Authorization header for Auth0 JWT callers.
  const credential = extractSessionToken(
    request.headers.get('Authorization'),
    request.headers.get('Cookie'),
  );

  if (!credential) {
    return json({ error: 'No token provided' }, 401);
  }

  const token = credential.token;

  try {
    const stored = await readKvJson(env.SESSIONS, token, StoredSession);

    if (stored) {
      if (!stored.ok) {
        return json({ error: 'Authentication failed' }, 401);
      }
      const session = stored.value;

      if (session.expires_at < Date.now()) {
        await env.SESSIONS.delete(token);
        return json({ error: 'Session expired' }, 401);
      }

      request.user = session.user;
      return;
    }

    const jwtPayload = await auth0Handler.verifyToken(token, env);
    const claims = v.safeParse(JwtClaims, jwtPayload);

    if (!jwtPayload || !claims.success) {
      return json({ error: 'Invalid token' }, 401);
    }

    request.user = {
      id: claims.output.sub,
      email: claims.output.email,
      name: claims.output.name ?? claims.output.nickname,
      picture: claims.output.picture,
      // Namespaced claim only; see config/auth0-roles.ts.
      roles: rolesFromToken(jwtPayload, createRoleConfig(env)),
    };

    request.auth0Token = jwtPayload;
  } catch {
    return json({ error: 'Authentication failed' }, 401);
  }

  return undefined;
}
