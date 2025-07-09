import { createRemoteJWKSet, jwtVerify } from 'jose';
import { nanoid } from 'nanoid';

export const auth0Handler = {
  // Login - redirect to Auth0
  async login(request) {
    const { env } = request;
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/api/auth/callback`;
    
    const authUrl = new URL(`https://${env.AUTH0_DOMAIN}/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', env.AUTH0_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', nanoid());
    
    return Response.redirect(authUrl.toString(), 302);
  },

  // Callback - handle Auth0 response
  async callback(request) {
    const { env } = request;
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    
    console.log('Auth0 callback received:', {
      hasCode: !!code,
      hasState: !!state,
      error: error,
      errorDescription: errorDescription,
      url: url.toString()
    });
    
    if (error) {
      console.error('Auth0 error:', error, errorDescription);
      return new Response(`Authentication error: ${errorDescription || error}`, { status: 401 });
    }
    
    if (!code) {
      return new Response('Authorization code missing', { status: 400 });
    }
    
    try {
      // Exchange code for tokens
      const redirectUri = `${url.origin}/api/auth/callback`;
      console.log('Token exchange params:', {
        domain: env.AUTH0_DOMAIN,
        clientId: env.AUTH0_CLIENT_ID,
        redirectUri: redirectUri,
        codeLength: code.length
      });
      
      const tokenResponse = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: env.AUTH0_CLIENT_ID,
          client_secret: env.AUTH0_CLIENT_SECRET,
          code: code,
          redirect_uri: redirectUri
        })
      });
      
      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        console.error('Token exchange failed:', error);
        console.error('Status:', tokenResponse.status);
        console.error('Headers:', tokenResponse.headers);
        return new Response(`Authentication failed: ${error}`, { status: 401 });
      }
      
      const tokens = await tokenResponse.json();
      
      // Get user info from Auth0
      const userResponse = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`
        }
      });
      
      if (!userResponse.ok) {
        return new Response('Failed to get user info', { status: 401 });
      }
      
      const userInfo = await userResponse.json();
      
      // Create or update user in database
      const userId = userInfo.sub;
      const user = {
        id: userId,
        email: userInfo.email,
        name: userInfo.name || userInfo.nickname,
        picture: userInfo.picture,
        provider: 'auth0'
      };
      
      // Check if this is a new user
      const existingUser = await env.DB.prepare(`
        SELECT id FROM users WHERE id = ?
      `).bind(userId).first();
      
      const isNewUser = !existingUser;
      
      // Create or update user with only existing columns
      if (isNewUser) {
        // Insert new user - only use columns that exist in the table
        await env.DB.prepare(`
          INSERT INTO users (id, email, name, provider, created_at, last_login)
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        `).bind(
          user.id, 
          user.email, 
          user.name, 
          user.provider
        ).run();
      } else {
        // Update existing user - only update columns that exist
        await env.DB.prepare(`
          UPDATE users SET
            email = ?,
            name = ?,
            last_login = datetime('now')
          WHERE id = ?
        `).bind(
          user.email, 
          user.name, 
          user.id
        ).run();
      }
      
      // Assign default group for new users
      if (isNewUser) {
        const defaultGroup = env.DEFAULT_USER_GROUP || 'viewer';
        await env.DB.prepare(`
          INSERT INTO user_groups (user_id, group_id, assigned_by)
          VALUES (?, ?, 'system')
        `).bind(userId, defaultGroup).run();
        
        // Create default user settings
        await env.DB.prepare(`
          INSERT INTO user_settings (user_id)
          VALUES (?)
        `).bind(userId).run();
      }
      
      // Check if user is in allowed domain (if configured)
      if (env.ALLOWED_EMAIL_DOMAINS) {
        const allowedDomains = env.ALLOWED_EMAIL_DOMAINS.split(',').map(d => d.trim());
        const emailDomain = user.email.split('@')[1];
        
        if (!allowedDomains.includes(emailDomain)) {
          // Update user as inactive
          await env.DB.prepare(`
            UPDATE users SET is_active = FALSE WHERE id = ?
          `).bind(userId).run();
          
          return new Response('Access denied: Email domain not allowed', { status: 403 });
        }
      }
      
      // Create session
      const sessionToken = nanoid();
      const sessionData = {
        user: user,
        id_token: tokens.id_token,
        expires_at: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
      };
      
      await env.SESSIONS.put(sessionToken, JSON.stringify(sessionData), {
        expirationTtl: 24 * 60 * 60 // 24 hours in seconds
      });
      
      // Redirect to frontend with session token - use the origin from the request
      const origin = url.origin;
      const frontendUrl = new URL(origin);
      frontendUrl.searchParams.set('token', sessionToken);
      
      return Response.redirect(frontendUrl.toString(), 302);
    } catch (error) {
      console.error('Auth callback error:', error);
      console.error('Error stack:', error.stack);
      return new Response(`Authentication failed: ${error.message}`, { status: 500 });
    }
  },

  // Logout
  async logout(request) {
    const { env } = request;
    const authHeader = request.headers.get('Authorization');
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      await env.SESSIONS.delete(token);
    }
    
    // Redirect to Auth0 logout
    const url = new URL(request.url);
    const logoutUrl = new URL(`https://${env.AUTH0_DOMAIN}/v2/logout`);
    logoutUrl.searchParams.set('client_id', env.AUTH0_CLIENT_ID);
    logoutUrl.searchParams.set('returnTo', url.origin);
    
    return Response.redirect(logoutUrl.toString(), 302);
  },

  // Get current user
  async me(request) {
    const { user } = request;
    
    return new Response(JSON.stringify({
      success: true,
      user: user
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  // Verify JWT token (for API calls)
  async verifyToken(token, env) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`));
      
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: `https://${env.AUTH0_DOMAIN}/`,
        audience: env.AUTH0_AUDIENCE || env.AUTH0_CLIENT_ID
      });
      
      return payload;
    } catch (error) {
      console.error('JWT verification failed:', error);
      return null;
    }
  }
};