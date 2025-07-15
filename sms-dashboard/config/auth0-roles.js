// Auth0 Role Configuration
// Configure which Auth0 roles have access to SMS functionality

// Create config from environment variables
export function createRoleConfig(env) {
  return {
    // The Auth0 role that grants full SMS access
    SMS_ROLE: env.AUTH0_SMS_ROLE || 'sms',
    
    // Alternative roles that can also access SMS (comma-separated)
    ALTERNATIVE_SMS_ROLES: env.AUTH0_ALTERNATIVE_SMS_ROLES ? 
      env.AUTH0_ALTERNATIVE_SMS_ROLES.split(',').map(r => r.trim()).filter(r => r.length > 0) : 
      [],
    
    // Where to find roles in the Auth0 token
    // Auth0 can put roles in different places depending on your configuration
    ROLE_NAMESPACE: env.AUTH0_ROLE_NAMESPACE || 'https://sexy.qzz.io/roles',
    
    // Whether to allow users without any roles (for testing)
    ALLOW_NO_ROLES: env.AUTH0_ALLOW_NO_ROLES === 'true' || false
  };
}

// Helper function to check if user has SMS access
export function hasSmSAccess(roles = [], config) {
  if (config.ALLOW_NO_ROLES && (!roles || roles.length === 0)) {
    return true;
  }
  
  const allowedRoles = [config.SMS_ROLE, ...config.ALTERNATIVE_SMS_ROLES];
  return roles.some(role => allowedRoles.includes(role));
}

// Get all roles that grant SMS access
export function getSmsRoles(config) {
  return [config.SMS_ROLE, ...config.ALTERNATIVE_SMS_ROLES];
}