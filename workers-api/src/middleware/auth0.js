import { auth0Handler } from '../handlers/auth0';

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
  
  // Check for Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'No token provided' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const token = authHeader.substring(7);
  
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
      picture: jwtPayload.picture
    };
    
    // Optionally update user in database
    try {
      // Check if user exists first
      const existingUser = await env.DB.prepare(`
        SELECT id FROM users WHERE id = ?
      `).bind(request.user.id).first();
      
      if (!existingUser) {
        // Insert new user
        await env.DB.prepare(`
          INSERT INTO users (id, email, name, provider, created_at, last_login)
          VALUES (?, ?, ?, 'auth0', datetime('now'), datetime('now'))
        `).bind(request.user.id, request.user.email, request.user.name).run();
      } else {
        // Update last login
        await env.DB.prepare(`
          UPDATE users SET last_login = datetime('now') WHERE id = ?
        `).bind(request.user.id).run();
      }
    } catch (dbError) {
      console.error('Failed to update user in database:', dbError);
      // Continue anyway - authentication is still valid
    }
    
  } catch (error) {
    console.error('Auth0 middleware error:', error);
    return new Response(JSON.stringify({ error: 'Authentication failed' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}