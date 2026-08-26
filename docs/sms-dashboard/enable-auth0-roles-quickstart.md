# Quick Start: Enable Auth0 Roles for SMS Dashboard

Follow these steps to enable role-based access control using Auth0.

## Step 1: Create the SMS Role in Auth0

1. Log in to your [Auth0 Dashboard](https://manage.auth0.com)
2. Navigate to **User Management** → **Roles**
3. Click **"+ Create Role"**
4. Enter:
   - **Name**: `sms`
   - **Description**: `Access to SMS dashboard features`
5. Click **Create**

## Step 2: Create an Auth0 Action to Add Roles to Tokens

1. In Auth0 Dashboard, go to **Actions** → **Flows** → **Login**
2. Click **"+"** → **Build Custom**
3. Name it: `Add Roles to Tokens`
4. Replace the code with:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://sexy.itoken.world/';
  
  // Get user roles
  const assignedRoles = event.authorization?.roles || [];
  
  // Add roles to both ID and Access tokens
  if (assignedRoles.length > 0) {
    api.idToken.setCustomClaim(namespace + 'roles', assignedRoles);
    api.accessToken.setCustomClaim(namespace + 'roles', assignedRoles);
  }
};
```

5. Click **Deploy**
6. Drag the action into the Login flow
7. Click **Apply**

## Step 3: Update Your Wrangler Configuration

Edit your `wrangler.toml` file:

```toml
# Auth0 Role Configuration
AUTH0_ADMIN_ROLE = "sms-admin"
AUTH0_VIEWER_ROLE = "sms-viewer"
AUTH0_ROLE_NAMESPACE = "https://sexy.itoken.world/roles"  # FULL claim URI; must match your Action

# Only these email domains may complete login. Addresses must also be email_verified.
ALLOWED_EMAIL_DOMAINS = "poloniex.com,bitgc.io,tron.network,htx-inc.com"
```

> There is no `USE_AUTH0_ROLES` or `AUTH0_ALLOW_NO_ROLES` setting any more. Role
> checking is always on and cannot be disabled from configuration — see
> [Security Review finding 1](../SECURITY-REVIEW.md).

## Step 4: Assign the SMS Role to Users

### For Existing Users:
1. Go to **User Management** → **Users**
2. Click on a user who should have SMS access
3. Go to the **Roles** tab
4. Click **Assign Roles**
5. Select `sms-admin` or `sms-viewer`
6. Click **Assign**

### For New Users (Optional - Auto-assign):
Create another Auth0 Action to auto-assign the SMS role to specific users:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  // Auto-assign SMS role to users from specific domain
  const userEmail = event.user.email || '';
  
  // Example: Give SMS role to all users from your company domain
  if (userEmail.endsWith('@yourcompany.com')) {
    api.addUserRole('rol_XXXXXXXXXXXXX'); // Replace with your SMS role ID
  }
};
```

## Step 5: Deploy Your Changes

```bash
cd sms-dashboard
npm run deploy
```

## Step 6: Test the Setup

### Test 1: User Without SMS Role
1. Log in with a user that doesn't have the SMS role
2. You should see a 403 error when trying to access the dashboard

### Test 2: User With SMS Role
1. Log in with a user that has the SMS role
2. You should have full access to all SMS features

## Troubleshooting

### Check if roles are in the token:
1. Log in to your app
2. Open browser DevTools → Network tab
3. Find the `/api/me` request
4. Check the response - it should show the user's roles

### If roles are missing:
1. Verify the Auth0 Action is deployed and in the Login flow
2. Check that the namespace in the Action matches `AUTH0_ROLE_NAMESPACE`
3. Ensure the user actually has roles assigned

### If you are locked out
Role checking cannot be disabled — there is deliberately no override flag. Recovery is
an Auth0 dashboard change and needs **no redeploy**, because role changes take effect on
the next login:

1. **User Management → Users →** your user **→ Roles → Assign Roles →** `sms`
2. Log out and back in.

If *nobody* can log in, the Action almost certainly is not emitting the claim — verify
it is deployed and active in the Login flow (Step 2), and that its namespace matches
`AUTH0_ROLE_NAMESPACE` exactly.

Also confirm the address is `email_verified` and on a domain in
`ALLOWED_EMAIL_DOMAINS`; both denials are recorded in the `audit_logs` table with a
`reason`, which is the fastest way to tell the two apart.

## Optional: Create Additional Roles

You can create more roles for different access levels:

1. **admin** - Full access to everything
2. **operator** - Can send/read messages but limited admin features
3. **viewer** - Read-only access (would need code changes)

There are deliberately only two roles. Adding a third means adding it to
`ROLE_PERMISSIONS` in `config/auth0-roles.js` with an explicit permission list — role
names are not a config-only knob, because a role with no declared permissions grants
nothing.

## Next Steps

1. Consider adding role-based UI elements (hide/show features based on roles)
2. Add audit logging for role-based actions
3. Set up role synchronization with your organization's directory

---

**Need Help?** Every user must hold `sms-admin` or `sms-viewer` (names from
`AUTH0_ADMIN_ROLE` / `AUTH0_VIEWER_ROLE`) and a verified address on an allowed domain. There is no
configuration that grants access without a role. If a user cannot get in, check
`audit_logs` for a `login_denied` row — its `reason` says which gate rejected them.
