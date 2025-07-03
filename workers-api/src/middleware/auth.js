// Cloudflare Zero Trust authentication middleware
export async function handleAuth(request) {
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
  
  // Check for session token
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return new Response(JSON.stringify({ error: 'No token provided' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Validate token from KV store
  const session = await env.SESSIONS.get(token, 'json');
  if (!session || session.expires < Date.now()) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Add user to request
  request.user = session.user;
}

// Generate session token
export function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}