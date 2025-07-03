import { generateToken } from '../middleware/auth';

export const authHandler = {
  // Initiate login with Cloudflare Zero Trust
  async login(request) {
    const { env } = request;
    const authUrl = `https://${env.CF_ACCESS_DOMAIN}/cdn-cgi/access/login/${env.CF_ACCESS_APP_ID}`;
    
    return Response.redirect(authUrl, 302);
  },
  
  // Handle OAuth callback
  async callback(request) {
    const { env } = request;
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    
    if (!code) {
      return new Response(JSON.stringify({ error: 'No code provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      // Exchange code for access token with Cloudflare Access
      const tokenResponse = await fetch(`https://${env.CF_ACCESS_DOMAIN}/cdn-cgi/access/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code,
          client_id: env.CF_ACCESS_CLIENT_ID,
          client_secret: env.CF_ACCESS_CLIENT_SECRET,
        }),
      });
      
      const tokenData = await tokenResponse.json();
      
      // Get user info
      const userResponse = await fetch(`https://${env.CF_ACCESS_DOMAIN}/cdn-cgi/access/user`, {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
        },
      });
      
      const userData = await userResponse.json();
      
      // Create session
      const sessionToken = generateToken();
      const session = {
        user: {
          id: userData.sub,
          email: userData.email,
          name: userData.name,
          provider: userData.provider || 'cloudflare',
        },
        expires: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
      };
      
      // Store session in KV
      await env.SESSIONS.put(sessionToken, JSON.stringify(session), {
        expirationTtl: 24 * 60 * 60, // 24 hours in seconds
      });
      
      // Store/update user in D1
      await env.DB.prepare(`
        INSERT INTO users (id, email, name, provider, last_login)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          last_login = CURRENT_TIMESTAMP
      `).bind(
        session.user.id,
        session.user.email,
        session.user.name,
        session.user.provider
      ).run();
      
      // Redirect to frontend with token
      return Response.redirect(`${env.FRONTEND_URL}?token=${sessionToken}`, 302);
    } catch (error) {
      console.error('Auth callback error:', error);
      return new Response(JSON.stringify({ error: 'Authentication failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Logout
  async logout(request) {
    const { env } = request;
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    
    if (token) {
      // Delete session from KV
      await env.SESSIONS.delete(token);
    }
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  },
  
  // Get current user
  async me(request) {
    return new Response(JSON.stringify({ user: request.user }), {
      headers: { 'Content-Type': 'application/json' }
    });
  },
};