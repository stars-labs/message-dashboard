// Simplified Role-Based Access Control middleware
// This version uses Auth0 roles instead of database RBAC tables

import { createRoleConfig, hasSmSAccess } from '../../config/auth0-roles.js';

/**
 * Every permission the SMS role grants. Single definition — this list was
 * previously copy-pasted in three places, so adding a permission meant editing
 * all three and any miss produced a silent 403.
 */
export const SMS_PERMISSIONS = [
  'phones.read',
  'messages.read',
  'messages.send',
  'keywords.read',
  'keywords.write',
  'keywords.delete',
  'filters.read',
  'filters.write',
  'filters.delete',
];

export function requirePermission(permission) {
  return async function(request) {
    const { user, env } = request;
    
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check if Auth0 role-based access is enabled
    const useAuth0Roles = env.USE_AUTH0_ROLES !== 'false'; // Default to true
    
    if (useAuth0Roles) {
      // Create role config from environment
      const roleConfig = createRoleConfig(env);
      
      // Check Auth0 roles
      const userRoles = user.roles || [];
      
      // For SMS-related permissions, check if user has the SMS role
      const smsPermissions = SMS_PERMISSIONS;
      if (smsPermissions.includes(permission)) {
        if (!hasSmSAccess(userRoles, roleConfig)) {
          const requiredRoles = [roleConfig.SMS_ROLE, ...roleConfig.ALTERNATIVE_SMS_ROLES].filter(r => r);
          const roleMessage = requiredRoles.length === 1 
            ? `You need the '${requiredRoles[0]}' role to access SMS features`
            : `You need one of these roles to access SMS features: ${requiredRoles.join(', ')}`;
            
          return new Response(JSON.stringify({ 
            error: 'Forbidden',
            message: roleMessage
          }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }
    
    // User has access
    return;
  };
}

// Simplified middleware that doesn't require RBAC tables
export async function enrichUserPermissions(request) {
  // Add SMS permissions based on Auth0 roles
  const { user, env } = request;
  
  if (!user) return;
  
  const useAuth0Roles = env.USE_AUTH0_ROLES !== 'false';
  
  if (useAuth0Roles) {
    // Create role config from environment
    const roleConfig = createRoleConfig(env);
    
    // When Auth0 roles are enabled, check roles strictly
    const userRoles = user.roles || [];
    if (hasSmSAccess(userRoles, roleConfig)) {
      user.permissions = [...SMS_PERMISSIONS];
    } else {
      user.permissions = [];
    }
  } else {
    // Only grant permissions when Auth0 roles are explicitly disabled
    user.permissions = [...SMS_PERMISSIONS];
  }
  
  return;
}