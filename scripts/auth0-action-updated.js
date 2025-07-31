exports.onExecutePostLogin = async (event, api) => {
    // Roles should only be set to verified users.
    if (!event.user.email || !event.user.email_verified) {
        return api.access.deny('Please verify your email first');
    }

    // Get the user's assigned roles from Auth0
    const assignedRoles = event.authorization?.roles || [];
    
    // Add roles to tokens with multiple namespaces for compatibility
    const namespace = 'https://sexy.qzz.io';
    
    // Add roles to ID token
    api.idToken.setCustomClaim(`${namespace}/roles`, assignedRoles);
    api.idToken.setCustomClaim('roles', assignedRoles);
    
    // Add roles to access token
    api.accessToken.setCustomClaim(`${namespace}/roles`, assignedRoles);
    api.accessToken.setCustomClaim('roles', assignedRoles);
    
    // Log for debugging (you can remove this in production)
    console.log(`User ${event.user.email} has roles: ${assignedRoles.join(', ')}`);
};