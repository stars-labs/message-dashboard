// Auth0 Role-Based Access Control middleware
// Simplified version that checks Auth0 roles directly from the token

export function requireRole(requiredRole) {
  return async function(request) {
    const { user, auth0Token } = request;
    
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check if user has the required role
    // Auth0 can provide roles in different ways:
    // 1. In custom namespace claim (e.g., https://yourapp.com/roles)
    // 2. In app_metadata.roles
    // 3. In authorization extension roles
    
    // Try to get roles from the token or user object
    const roles = auth0Token?.roles || 
                  auth0Token?.['https://yourapp.com/roles'] || 
                  user.roles || 
                  [];
    
    if (!roles.includes(requiredRole)) {
      return new Response(JSON.stringify({ 
        error: 'Forbidden',
        message: `You do not have the required role: ${requiredRole}`
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // User has the required role
    return;
  };
}

export function requireAnyRole(requiredRoles) {
  return async function(request) {
    const { user, auth0Token } = request;
    
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get roles from token or user
    const roles = auth0Token?.roles || 
                  auth0Token?.['https://yourapp.com/roles'] || 
                  user.roles || 
                  [];
    
    // Check if user has any of the required roles
    const hasRole = requiredRoles.some(role => roles.includes(role));
    
    if (!hasRole) {
      return new Response(JSON.stringify({ 
        error: 'Forbidden',
        message: `You need one of these roles: ${requiredRoles.join(', ')}`
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return;
  };
}

// Middleware to extract Auth0 roles from token
export async function enrichAuth0Roles(request) {
  if (!request.user || !request.auth0Token) {
    return;
  }
  
  // Extract roles from various possible locations in the Auth0 token
  const token = request.auth0Token;
  
  // Common locations where Auth0 might put roles
  const roles = token.roles || 
                token['https://yourapp.com/roles'] || 
                token['https://yourapp.com/app_metadata']?.roles ||
                token.app_metadata?.roles ||
                [];
  
  // Add roles to the user object for easy access
  request.user.roles = Array.isArray(roles) ? roles : [roles];
  
  return;
}