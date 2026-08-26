# Production Auth0 Role-Based Access Checklist

## ✅ Production-Ready Changes Made

1. **Removed all mock/demo authentication code**
   - No more demo users
   - Auth0 is now required for all authentication
   - Returns proper error if Auth0 is not configured

2. **Strict role enforcement enabled**
   - Users MUST hold `sms-admin` or `sms-viewer` to access any SMS features
   - No fallback access for users without roles
   - Clear error messages for unauthorized users

3. **Clean production configuration**
   ```toml
   AUTH0_ADMIN_ROLE = "sms-admin"
   AUTH0_VIEWER_ROLE = "sms-viewer"
   AUTH0_ROLE_NAMESPACE = "https://sexy.itoken.world/roles"
   ALLOWED_EMAIL_DOMAINS = "poloniex.com,bitgc.io,tron.network,htx-inc.com"
   ```

   Plus two secrets for the Management API (role reads and changes):
   ```bash
   wrangler secret put AUTH0_M2M_CLIENT_ID
   wrangler secret put AUTH0_M2M_CLIENT_SECRET
   ```

   `USE_AUTH0_ROLES` and `AUTH0_ALLOW_NO_ROLES` no longer exist. Both could only ever
   turn authorization off, and production shipped with `USE_AUTH0_ROLES = "false"`,
   which granted every authenticated user every permission — full read access to all
   SMS bodies and verification codes. The gate now fails closed in code and cannot be
   disabled by configuration. See [Security Review finding 1](../SECURITY-REVIEW.md).

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

### 2. Create Auth0 Roles
1. Log in to Auth0 Dashboard
2. Go to **User Management** → **Roles**
3. Create **both** roles: `sms-admin` and `sms-viewer`
4. **Assign `sms-admin` to yourself now.** Do this before deploying — the role-management UI
   is admin-only, and the server refuses to let anyone change their own role, so an empty
   admin set can only be fixed from the Auth0 dashboard.

| Role | Can |
|---|---|
| `sms-viewer` | Read messages, see the SIM list, send SMS |
| `sms-admin` | Everything, plus manage other users' roles |

New users are auto-assigned `sms-viewer` on first login (after the verified-email and
allowed-domain checks pass), so no manual step is needed for joiners.

### 2b. Create the machine-to-machine app
Needed for reading users and changing roles from the dashboard.

1. **Applications → Applications → Create Application** → *Machine to Machine*
2. Authorise it for the **Auth0 Management API**
3. Grant exactly these scopes — **not** `delete:users`:
   `read:users`, `read:roles`, `update:users`
4. `wrangler secret put AUTH0_M2M_CLIENT_ID` and `AUTH0_M2M_CLIENT_SECRET`

### 3. Add Roles to Tokens (Auth0 Action)
```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://sexy.itoken.world/';
  const assignedRoles = event.authorization?.roles || [];
  
  if (assignedRoles.length > 0) {
    api.idToken.setCustomClaim(namespace + 'roles', assignedRoles);
    api.accessToken.setCustomClaim(namespace + 'roles', assignedRoles);
  }
};
```

### 4. Assign Roles to Users
- `sms-admin` is assigned in the Auth0 dashboard, or from the app's 用户管理 page by an
  existing admin
- `sms-viewer` is assigned automatically on first login; you can also set it manually
- A role change from the app **revokes that user's live sessions**, so it takes effect on
  their next request rather than up to 24 hours later

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

1. **First-time setup**: Make sure the Action below is deployed **and** at least one user
   holds `sms-admin` **before** deploying. Authorization fails closed: if the Action is
   not emitting the claim, nobody can log in.
2. **Role changes**: Role changes in Auth0 take effect on next login
3. **Emergency access**: there is no override flag. Recovery is assigning `sms-admin`
   in the Auth0 dashboard, which needs no redeploy (see Troubleshooting)
4. **Verified email required**: addresses must be `email_verified` and on a domain in
   `ALLOWED_EMAIL_DOMAINS`; a connection that does not set that claim will deny login

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
   - User must hold `sms-admin` or `sms-viewer`

3. **Check namespace matches**
   - Action sets claim: `https://sexy.itoken.world/` + `roles`
   - Config expects the FULL claim URI: `AUTH0_ROLE_NAMESPACE = "https://sexy.itoken.world/roles"`

4. **Check the email gate**
   - Address must be `email_verified: true`
   - Domain must be listed in `ALLOWED_EMAIL_DOMAINS`
   - Both denials write a `login_denied` row to `audit_logs` with a `reason` field —
     read it rather than guessing which gate fired

5. **Recovery** — no redeploy required, and there is no disable flag:
   **User Management → Users →** the user **→ Roles → Assign Roles →** `sms`, then have
   them log in again.
