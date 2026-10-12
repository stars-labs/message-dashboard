import { Elysia } from 'elysia';
import { jwtVerify, importSPKI } from 'jose';

export interface User {
  id: string;
  email: string;
  name?: string;
  permissions?: string[];
  roles?: string[];
}

/**
 * Verify Auth0 JWT token
 */
async function verifyAuth0Token(token: string, env: any): Promise<any> {
  const domain = env.AUTH0_DOMAIN;
  const audience = env.AUTH0_AUDIENCE;
  
  if (!domain) {
    throw new Error('AUTH0_DOMAIN not configured');
  }
  
  // Fetch JWKS
  const jwksResponse = await fetch(`https://${domain}/.well-known/jwks.json`);
  const jwks = await jwksResponse.json();
  
  // Decode token header to get kid
  const [header] = token.split('.');
  const decodedHeader = JSON.parse(atob(header));
  const key = jwks.keys.find((k: any) => k.kid === decodedHeader.kid);
  
  if (!key) {
    throw new Error('No matching key found in JWKS');
  }
  
  // Import the public key
  const publicKey = await importSPKI(key.x5c[0], key.alg);
  
  // Verify the token
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: `https://${domain}/`,
    audience: audience || undefined
  });
  
  return payload;
}

/**
 * Auth middleware for ElysiaJS
 */
export const authMiddleware = new Elysia({ name: 'auth' })
  .derive(async ({ request, set }) => {
    const env = (request as any).env || process.env;
    const headers = request.headers;
    
    // Extract token from Authorization header
    const authHeader = headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    
    // Check for API key (for Orange Pi)
    const apiKey = headers.get('x-api-key');
    if (apiKey === env.API_KEY) {
      return {
        user: null,
        isApiKey: true,
        permissions: ['control.write', 'phones.write', 'messages.write']
      };
    }
    
    // If no token and not API key, user is not authenticated
    if (!token) {
      return {
        user: null,
        isApiKey: false,
        permissions: []
      };
    }
    
    try {
      // Verify JWT token
      const payload = await verifyAuth0Token(token, env);
      
      // Extract user info
      const user: User = {
        id: payload.sub as string,
        email: payload.email as string,
        name: payload.name as string,
        permissions: payload.permissions as string[] || [],
        roles: payload[`${env.AUTH0_ROLE_NAMESPACE}/roles`] as string[] || []
      };
      
      return {
        user,
        isApiKey: false,
        permissions: user.permissions || []
      };
    } catch (error) {
      console.error('[Auth] Token verification failed:', error);
      return {
        user: null,
        isApiKey: false,
        permissions: []
      };
    }
  });

/**
 * Require authentication
 */
export function requireAuth() {
  return new Elysia()
    .derive(({ user, set }) => {
      if (!user) {
        set.status = 401;
        throw new Error('Authentication required');
      }
      return {};
    });
}

/**
 * Require specific permission
 */
export function requirePermission(permission: string) {
  return new Elysia()
    .derive(({ user, permissions, set }) => {
      if (!user && !permissions.includes(permission)) {
        set.status = 401;
        throw new Error('Authentication required');
      }
      
      if (!permissions.includes(permission)) {
        set.status = 403;
        throw new Error(`Permission required: ${permission}`);
      }
      
      return {};
    });
}