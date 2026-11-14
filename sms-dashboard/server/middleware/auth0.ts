import * as v from 'valibot';
import { auth0Handler, StoredSession } from '../handlers/auth0.js';
import type { SessionUser } from '../../shared/api/auth.js';
import { readKvJson, type KV } from '../lib/kv.js';
import { json } from '../lib/response.js';
import { secretMatches } from '../lib/secret.js';
import { createRoleConfig, rolesFromToken, type RoleEnv } from '../../config/auth0-roles.js';
import { extractSessionToken } from '../utils/session-token.js';

export interface AuthRequest {
  url: string;
  headers: { get(name: string): string | null };
  env: RoleEnv & {
    API_KEY?: string;
    AUTH0_DOMAIN?: string;
    AUTH0_AUDIENCE?: string;
    AUTH0_CLIENT_ID?: string;
    SESSIONS: KV<'get' | 'delete'>;
  };
  user?: SessionUser;
  auth0Token?: Record<string, unknown>;
}

/** The standard claims read from a verified Auth0 JWT; roles come from the configured claim. */
const JwtClaims = v.object({
  sub: v.string(),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  nickname: v.optional(v.string()),
  picture: v.optional(v.string()),
});

// Auth0 authentication middleware
export async function handleAuth0(request: AuthRequest): Promise<Response | undefined> {
  const { env } = request;

  // Check for API key for control endpoints
  if (new URL(request.url).pathname.startsWith('/api/control/')) {
    if (!(await secretMatches(request.headers.get('X-API-Key'), env.API_KEY))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return; // Continue to handler
  }

  // Credential comes from the HttpOnly auth_token cookie for browsers, or an
  // Authorization header for programmatic callers presenting an Auth0 JWT.
  // See docs/SECURITY-REVIEW.md finding 4.
  const credential = extractSessionToken(
    request.headers.get('Authorization'),
    request.headers.get('Cookie'),
  );

  if (!credential) {
    return json({ error: 'No token provided' }, 401);
  }

  const token = credential.token;

  try {
    // First check if it's a session token in KV store
    const stored = await readKvJson(env.SESSIONS, token, StoredSession);

    if (stored) {
      if (!stored.ok) {
        return json({ error: 'Authentication failed' }, 401);
      }
      const session = stored.value;

      // Check if session is expired
      if (session.expires_at < Date.now()) {
        await env.SESSIONS.delete(token);
        return json({ error: 'Session expired' }, 401);
      }

      // Add user to request
      request.user = session.user;
      return; // Continue to handler
    }

    // If not a session token, try to verify as Auth0 JWT
    const jwtPayload = await auth0Handler.verifyToken(token, env);
    const claims = v.safeParse(JwtClaims, jwtPayload);

    if (!jwtPayload || !claims.success) {
      return json({ error: 'Invalid token' }, 401);
    }

    // Create user object from JWT payload
    request.user = {
      id: claims.output.sub,
      email: claims.output.email,
      name: claims.output.name ?? claims.output.nickname,
      picture: claims.output.picture,
      // Namespaced claim only — see config/auth0-roles.ts and
      // docs/SECURITY-REVIEW.md finding 5.
      roles: rolesFromToken(jwtPayload, createRoleConfig(env)),
    };

    // Store the full Auth0 token payload for role checking
    request.auth0Token = jwtPayload;
  } catch {
    // Auth0 middleware error
    return json({ error: 'Authentication failed' }, 401);
  }

  return undefined;
}
