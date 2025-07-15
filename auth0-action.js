/**
 * Handler that will be called during the execution of a PostLogin flow.
 *
 * @param {Event} event - Details about the user and the context in which they are logging in.
 * @param {PostLoginAPI} api - Interface whose methods can be used to change the behavior of the login.
 */
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://sexy.qzz.io';
  
  if (event.authorization) {
    // Get user's roles
    const assignedRoles = event.authorization.roles || [];
    
    // Add roles to ID token
    api.idToken.setCustomClaim(`${namespace}/roles`, assignedRoles);
    
    // Add roles to access token
    api.accessToken.setCustomClaim(`${namespace}/roles`, assignedRoles);
    
    // Also add to root level for easier access
    api.idToken.setCustomClaim('roles', assignedRoles);
    api.accessToken.setCustomClaim('roles', assignedRoles);
  }
};