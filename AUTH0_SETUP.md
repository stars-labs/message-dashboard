# Auth0 Configuration Guide

## 1. Auth0 Application Settings

In your Auth0 dashboard, go to Applications and configure:

### Allowed Callback URLs
```
https://sexy.qzz.io/callback
http://localhost:5173/callback
```

### Allowed Logout URLs
```
https://sexy.qzz.io
http://localhost:5173
```

### Allowed Web Origins
```
https://sexy.qzz.io
http://localhost:5173
```

## 2. Create Auth0 Action to Add Roles

Go to Auth0 Dashboard > Actions > Flows > Login

Create a new custom action called "Add Roles to Tokens":

```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://sexy.qzz.io/roles';
  
  if (event.authorization) {
    // Get user's roles from Auth0
    const assignedRoles = event.authorization.roles || [];
    
    // Add roles to ID token
    api.idToken.setCustomClaim(namespace, assignedRoles);
    
    // Add roles to access token  
    api.accessToken.setCustomClaim(namespace, assignedRoles);
    
    // Also add to root level for userinfo endpoint
    api.user.setUserMetadata('roles', assignedRoles);
  }
};
```

Deploy and add this action to your Login flow.

## 3. Create SMS Role

1. Go to Auth0 Dashboard > User Management > Roles
2. Click "Create Role"
3. Name: `sms`
4. Description: `Access to SMS dashboard`
5. Save

## 4. Assign Role to Users

1. Go to Auth0 Dashboard > User Management > Users
2. Select a user
3. Go to "Roles" tab
4. Click "Assign Roles"
5. Select the `sms` role
6. Save

## 5. Set Cloudflare Worker Secrets

Run these commands:

```bash
cd sms-dashboard

# Set your Auth0 domain (e.g., your-tenant.auth0.com)
npx wrangler secret put AUTH0_DOMAIN

# Set your Auth0 application Client ID
npx wrangler secret put AUTH0_CLIENT_ID

# Set your Auth0 application Client Secret
npx wrangler secret put AUTH0_CLIENT_SECRET

# Set API key for Orange Pi
npx wrangler secret put API_KEY
```

## 6. Deploy

```bash
npm run deploy
```

## Troubleshooting

### Check if roles are being added to tokens
1. Test login at https://sexy.qzz.io
2. Decode the ID token at https://jwt.io
3. Look for the `https://sexy.qzz.io/roles` claim
4. It should contain `["sms"]` if the user has the role

### Common Issues
- **"Failed to get user info"**: Check that the Auth0 secrets are set correctly
- **"Access denied"**: User doesn't have the `sms` role assigned
- **Redirect issues**: Ensure callback URLs are exactly as shown above