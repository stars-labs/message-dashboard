# Production Auth0 Role-Based Access Checklist

## ✅ Production-Ready Changes Made

1. **Removed all mock/demo authentication code**
   - No more demo users
   - Auth0 is now required for all authentication
   - Returns proper error if Auth0 is not configured

2. **Strict role enforcement enabled**
   - Users MUST have `sms` role to access any SMS features
   - No fallback access for users without roles
   - Clear error messages for unauthorized users

3. **Clean production configuration**
   ```toml
   USE_AUTH0_ROLES = "true"
   AUTH0_SMS_ROLE = "sms"
   AUTH0_ALTERNATIVE_SMS_ROLES = ""
   AUTH0_ROLE_NAMESPACE = "https://sexy.qzz.io/roles"
   AUTH0_ALLOW_NO_ROLES = "false"
   ```

## 📋 Deployment Steps

### 1. Configure Auth0 Secrets
```bash
wrangler secret put AUTH0_DOMAIN
# Enter: your-tenant.auth0.com

wrangler secret put AUTH0_CLIENT_ID
# Enter: your Auth0 application client ID

wrangler secret put AUTH0_CLIENT_SECRET
# Enter: your Auth0 application client secret

wrangler secret put API_KEY
# Enter: your API key for Orange Pi
```

### 2. Create Auth0 Role
1. Log in to Auth0 Dashboard
2. Go to **User Management** → **Roles**
3. Create role: `sms`

### 3. Add Roles to Tokens (Auth0 Action)
```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://sexy.qzz.io/';
  const assignedRoles = event.authorization?.roles || [];
  
  if (assignedRoles.length > 0) {
    api.idToken.setCustomClaim(namespace + 'roles', assignedRoles);
    api.accessToken.setCustomClaim(namespace + 'roles', assignedRoles);
  }
};
```

### 4. Assign Roles to Users
- Assign `sms` role to users who need SMS access

### 5. Deploy
```bash
npm run deploy
```

## 🔒 Security Features

- **No bypass**: All users must authenticate through Auth0
- **Role required**: Users must have explicit role assignment
- **No test accounts**: No demo/mock users in production
- **Clear errors**: Users without roles see clear error messages

## 🚨 Important Notes

1. **First-time setup**: Make sure at least one user has the `sms` role before deploying
2. **Role changes**: Role changes in Auth0 take effect on next login
3. **Emergency access**: Keep `USE_AUTH0_ROLES = "false"` as emergency override only

## 📊 Monitoring

After deployment, monitor:
- Failed login attempts (403 errors)
- Users without roles trying to access
- Successful authentications with roles

## 🆘 Troubleshooting

If users can't access after deployment:

1. **Check Auth0 Action is deployed**
   - Must be in Login flow
   - Must be active

2. **Verify user has role**
   - Check in Auth0 Dashboard
   - User must have `sms` role

3. **Check namespace matches**
   - Action uses: `https://sexy.qzz.io/`
   - Config expects: `https://sexy.qzz.io/roles`

4. **Emergency disable** (temporary only!)
   ```toml
   USE_AUTH0_ROLES = "false"
   ```
   Then redeploy.