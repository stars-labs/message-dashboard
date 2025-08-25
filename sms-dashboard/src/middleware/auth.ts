import { Context, Next } from 'hono';
import { verify } from 'hono/jwt';
import * as jose from 'jose';

// Type definitions for our context
type AuthBindings = {
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  AUTH0_AUDIENCE?: string;
  SESSIONS: KVNamespace;
  USE_AUTH0_ROLES: string;
  AUTH0_SMS_ROLE: string;
  AUTH0_ROLE_NAMESPACE: string;
  AUTH0_ALLOW_NO_ROLES: string;
};

type AuthVariables = {
  user?: any;
  userPermissions?: string[];
};

type AuthContext = Context<{
  Bindings: AuthBindings;
  Variables: AuthVariables;
}>;

// Auth0 token validation
export async function validateAuth0Token(token: string, env: AuthBindings) {
  try {
    const JWKS = jose.createRemoteJWKSet(
      new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`)
    );

    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: `https://${env.AUTH0_DOMAIN}/`,
      audience: env.AUTH0_AUDIENCE,
    });

    return payload;
  } catch (error) {
    console.error('Token validation error:', error);
    return null;
  }
}

// Main auth middleware
export async function authMiddleware(c: AuthContext, next: Next) {
  // Check for API key auth (for control endpoints)
  const apiKey = c.req.header('X-API-Key');
  if (apiKey) {
    // This is handled separately for control endpoints
    return next();
  }

  // Helper function to validate session token from KV storage
  const validateSessionToken = async (sessionToken: string) => {
    const sessionData = await c.env.SESSIONS.get(sessionToken);
    
    if (sessionData) {
      const session = JSON.parse(sessionData);
      if (session.expires_at > Date.now()) {
        c.set('user', session.user);
        return true;
      }
    }
    return false;
  };

  // Check for Bearer token
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    // First, try to treat the token as a session token (for tokens from URL redirect)
    if (await validateSessionToken(token)) {
      return next();
    }
    
    // If that fails, try to validate as JWT token (for actual JWT tokens)
    const payload = await validateAuth0Token(token, c.env);
    if (payload) {
      // Extract user information
      const user = {
        sub: payload.sub,
        email: payload.email || payload.name,
        permissions: payload.permissions || [],
        roles: payload[`${c.env.AUTH0_ROLE_NAMESPACE}/roles`] || [],
        ...payload
      };

      c.set('user', user);
      return next();
    }
  }

  // Check for session cookie
  const cookieHeader = c.req.header('Cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c: string) => c.trim());
    const authCookie = cookies.find((c: string) => c.startsWith('auth_token='));
    
    if (authCookie) {
      const sessionToken = authCookie.split('=')[1];
      if (await validateSessionToken(sessionToken)) {
        return next();
      }
    }
  }
  
  return c.json({ error: 'Unauthorized' }, 401);
}

// Permission check middleware factory
export function requirePermission(permission: string) {
  return async (c: AuthContext, next: Next) => {
    const user = c.get('user');
    
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Check if user has the required permission
    const userPermissions = c.get('userPermissions') || [];
    
    if (!userPermissions.includes(permission)) {
      // Check if permission is granted by role
      const rolePermissions = getRolePermissions(user.roles, c.env);
      
      if (!rolePermissions.includes(permission)) {
        return c.json({ 
          error: 'Forbidden',
          message: `Missing required permission: ${permission}`
        }, 403);
      }
    }

    await next();
  };
}

// Get permissions based on roles
function getRolePermissions(roles: string[], env: AuthBindings): string[] {
  const permissions: string[] = [];
  
  // Check if role-based access is enabled
  if (env.USE_AUTH0_ROLES !== 'true') {
    // If roles are disabled, grant all permissions
    return ['phones.read', 'phones.write', 'messages.read', 'messages.send', 'messages.write', 'keywords.read', 'keywords.write'];
  }
  
  // Check for SMS role
  if (roles.includes(env.AUTH0_SMS_ROLE)) {
    permissions.push(
      'phones.read',
      'phones.write',
      'messages.read',
      'messages.send',
      'messages.write',
      'keywords.read',
      'keywords.write'
    );
  }
  
  // Add any additional role-based permissions here
  if (roles.includes('admin')) {
    permissions.push('admin.all');
  }
  
  if (roles.includes('viewer')) {
    permissions.push('phones.read', 'messages.read', 'keywords.read');
  }
  
  return [...new Set(permissions)]; // Remove duplicates
}

// Enrich user permissions middleware
export async function enrichUserPermissions(c: AuthContext, next: Next) {
  const user = c.get('user');
  
  if (user) {
    const rolePermissions = getRolePermissions(user.roles || [], c.env);
    const directPermissions = user.permissions || [];
    
    // Combine role and direct permissions
    const allPermissions = [...new Set([...rolePermissions, ...directPermissions])];
    
    c.set('userPermissions', allPermissions);
  }
  
  await next();
}

// API Key authentication middleware for control endpoints
export async function apiKeyAuth(c: AuthContext, next: Next) {
  const apiKey = c.req.header('X-API-Key');
  const env = c.env as any;
  
  if (!apiKey || apiKey !== env.API_KEY) {
    return c.json({ error: 'Invalid API key' }, 401);
  }
  
  // Set a system user for API key auth
  c.set('user', {
    sub: 'system:api',
    email: 'api@system',
    permissions: ['control.all'],
    roles: ['system']
  });
  
  await next();
}