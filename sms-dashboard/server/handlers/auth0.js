import { createRemoteJWKSet, jwtVerify } from 'jose';
import { nanoid } from 'nanoid';

export const auth0Handler = {
  // Login - redirect to Auth0
  async login(request) {
    console.log('[Auth0 Handler] Login route hit');
    const { env } = request;
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/callback`;
    
    if (!env.AUTH0_DOMAIN || !env.AUTH0_CLIENT_ID) {
      // Auth0 not configured - return error
      return new Response('Auth0 configuration missing. Please configure AUTH0_DOMAIN and AUTH0_CLIENT_ID.', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    const authUrl = new URL(`https://${env.AUTH0_DOMAIN}/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', env.AUTH0_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', nanoid());
    
    // Add audience if configured to ensure we get a proper access token
    if (env.AUTH0_AUDIENCE) {
      authUrl.searchParams.set('audience', env.AUTH0_AUDIENCE);
    }
    
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
    
    
    if (error) {
      return new Response(`Authentication error: ${errorDescription || error}`, { status: 401 });
    }
    
    if (!code) {
      return new Response('Authorization code missing', { status: 400 });
    }
    
    try {
      // Exchange code for tokens
      const redirectUri = `${url.origin}/callback`;
      // Token exchange with Auth0
      
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
        console.error('Token exchange failed:', tokenResponse.status, error);
        // Token exchange failed
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
        const errorText = await userResponse.text();
        console.error('Failed to get user info:', userResponse.status, errorText);
        return new Response(`Failed to get user info: ${errorText || userResponse.statusText}`, { status: 401 });
      }
      
      const userInfo = await userResponse.json();
      
      // Create or update user in database
      const userId = userInfo.sub;
      
      // Try to get roles from various possible locations
      let userRoles = [];
      
      // Check userInfo for roles
      if (userInfo.roles) {
        userRoles = userInfo.roles;
      } else if (userInfo['https://sexy.qzz.io/roles']) {
        userRoles = userInfo['https://sexy.qzz.io/roles'];
      }
      
      // If no roles in userInfo, decode the access token to check
      if (userRoles.length === 0 && tokens.access_token) {
        try {
          // Decode token without verification just to read claims
          const tokenParts = tokens.access_token.split('.');
          if (tokenParts.length === 3) {
            const payload = JSON.parse(atob(tokenParts[1]));
            userRoles = payload.roles || payload['https://sexy.qzz.io/roles'] || [];
          }
        } catch (e) {
          console.error('Failed to decode access token:', e);
        }
      }
      
      console.log('User roles found:', userRoles);
      
      const user = {
        id: userId,
        email: userInfo.email,
        name: userInfo.name || userInfo.nickname,
        picture: userInfo.picture,
        provider: 'auth0',
        roles: userRoles
      };
      
      // No need to store user in database - Auth0 handles user management
      // Just log the authentication event in audit_logs
      await env.DB.prepare(`
        INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
        VALUES ('login', 'user', ?, ?, ?, datetime('now'))
      `).bind(
        user.id,
        user.email,
        JSON.stringify({ provider: 'auth0', roles: userRoles })
      ).run();
      
      // Check if user is in allowed domain (if configured)
      if (env.ALLOWED_EMAIL_DOMAINS) {
        const allowedDomains = env.ALLOWED_EMAIL_DOMAINS.split(',').map(d => d.trim());
        const emailDomain = user.email.split('@')[1];
        
        if (!allowedDomains.includes(emailDomain)) {
          // Log denied access attempt
          await env.DB.prepare(`
            INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
            VALUES ('login_denied', 'user', ?, ?, ?, datetime('now'))
          `).bind(
            user.id,
            user.email,
            JSON.stringify({ reason: 'Email domain not allowed', domain: emailDomain })
          ).run();
          
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
      
      // Check if user has SMS role
      const roleConfig = {
        SMS_ROLE: env.AUTH0_SMS_ROLE || 'sms',
        ALTERNATIVE_SMS_ROLES: env.AUTH0_ALTERNATIVE_SMS_ROLES ? 
          env.AUTH0_ALTERNATIVE_SMS_ROLES.split(',').map(r => r.trim()).filter(r => r.length > 0) : 
          [],
        ALLOW_NO_ROLES: env.AUTH0_ALLOW_NO_ROLES === 'true'
      };
      
      const hasRole = roleConfig.ALLOW_NO_ROLES || 
        user.roles.includes(roleConfig.SMS_ROLE) || 
        user.roles.some(role => roleConfig.ALTERNATIVE_SMS_ROLES.includes(role));
      
      if (!hasRole && env.USE_AUTH0_ROLES !== 'false') {
        // User doesn't have required role - redirect to login with error
        return Response.redirect(new URL('/login?error=no_role', url.origin).toString(), 302);
      }
      
      // Redirect to frontend with session token in URL
      const origin = url.origin;
      const frontendUrl = new URL('/', origin);
      frontendUrl.searchParams.set('token', sessionToken);
      
      // Create response with redirect
      const response = new Response(null, {
        status: 302,
        headers: {
          'Location': frontendUrl.toString(),
          // Also set cookie for server-side auth checks
          'Set-Cookie': `auth_token=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
        }
      });
      
      return response;
    } catch (error) {
      // Auth callback error
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
      // JWT verification failed
      return null;
    }
  }
};