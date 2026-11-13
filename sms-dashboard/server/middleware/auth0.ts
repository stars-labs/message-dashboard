import { auth0Handler } from '../handlers/auth0';
import { createRoleConfig, rolesFromToken } from '../../config/auth0-roles.js';
import { extractSessionToken } from '../utils/session-token.js';
import type { AppRequest, Handler, RequestUser } from '../worker-context.js';

/** The session payload KV holds under the auth_token value. */
interface StoredSession {
  expires_at: number;
  user: RequestUser;
}

// Auth0 authentication middleware
export const handleAuth0: Handler = async (request: AppRequest) => {
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
    const sessionData = await env.SESSIONS.get(token);

    if (sessionData) {
      const session = JSON.parse(sessionData) as StoredSession;

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

    if (!jwtPayload) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create user object from JWT payload
    request.user = {
      id: String(jwtPayload.sub),
      email: jwtPayload.email as string | undefined,
      name: (jwtPayload.name ?? jwtPayload.nickname) as string | undefined,
      picture: jwtPayload.picture as string | undefined,
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
};