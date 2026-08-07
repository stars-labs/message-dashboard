import { auth0Handler } from '../handlers/auth0';
import { createRoleConfig, rolesFromToken } from '../../config/auth0-roles.js';
import { extractSessionToken } from '../utils/session-token.js';

// Auth0 authentication middleware
export async function handleAuth0(request) {
  const { env } = request;
  
  // Check for API key for control endpoints
  if (request.url.includes('/api/control/')) {
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return; // Continue to handler
  }
  
  // Credential comes from the HttpOnly auth_token cookie for browsers, or an
  // Authorization header for programmatic callers presenting an Auth0 JWT.
  // See docs/SECURITY-REVIEW.md finding 4.
  const credential = extractSessionToken(
    request.headers.get('Authorization'),
    request.headers.get('Cookie')
  );

  if (!credential) {
    return new Response(JSON.stringify({ error: 'No token provided' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const token = credential.token;

  try {
    // First check if it's a session token in KV store
    const sessionData = await env.SESSIONS.get(token);
    
    if (sessionData) {
      const session = JSON.parse(sessionData);
      
      // Check if session is expired
      if (session.expires_at < Date.now()) {
        await env.SESSIONS.delete(token);
        return new Response(JSON.stringify({ error: 'Session expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
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
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Create user object from JWT payload
    request.user = {
      id: jwtPayload.sub,
      email: jwtPayload.email,
      name: jwtPayload.name || jwtPayload.nickname,
      picture: jwtPayload.picture,
      // Namespaced claim only — see config/auth0-roles.js and
      // docs/SECURITY-REVIEW.md finding 5.
      roles: rolesFromToken(jwtPayload, createRoleConfig(env))
    };
    
    // Store the full Auth0 token payload for role checking
    request.auth0Token = jwtPayload;
    
  } catch (error) {
    // Auth0 middleware error
    return new Response(JSON.stringify({ error: 'Authentication failed' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}