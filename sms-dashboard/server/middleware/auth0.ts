import * as v from 'valibot';
import { auth0Handler, StoredSession, type SessionUser } from '../handlers/auth0.js';
import { readKvJson, type KV } from '../lib/kv.js';
import { createRoleConfig, rolesFromToken, type RoleEnv } from '../../config/auth0-roles.js';
import { extractSessionToken } from '../utils/session-token.js';

interface AuthRequest {
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
  if (request.url.includes('/api/control/')) {
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
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
    return new Response(JSON.stringify({ error: 'No token provided' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = credential.token;

  try {
    // First check if it's a session token in KV store
    const stored = await readKvJson(env.SESSIONS, token, StoredSession);

    if (stored) {
      if (!stored.ok) {
        return new Response(JSON.stringify({ error: 'Authentication failed' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const session = stored.value;

      // Check if session is expired
      if (session.expires_at < Date.now()) {
        await env.SESSIONS.delete(token);
        return new Response(JSON.stringify({ error: 'Session expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Add user to request
      request.user = session.user;
      return; // Continue to handler
    }

    // If not a session token, try to verify as Auth0 JWT
    const jwtPayload = await auth0Handler.verifyToken(token, env);
    const claims = v.safeParse(JwtClaims, jwtPayload);

    if (!jwtPayload || !claims.success) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
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
    return new Response(JSON.stringify({ error: 'Authentication failed' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return undefined;
}
