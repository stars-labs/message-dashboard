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
  const namespace = 'https://sexy.qzz.io/';
  
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
USE_AUTH0_ROLES = "true"
AUTH0_SMS_ROLE = "sms"
AUTH0_ALTERNATIVE_SMS_ROLES = "admin,operator"
AUTH0_ROLE_NAMESPACE = "https://sexy.qzz.io/roles"  # Must match the namespace in your Action
AUTH0_ALLOW_NO_ROLES = "false"
```

## Step 4: Assign the SMS Role to Users

### For Existing Users:
1. Go to **User Management** → **Users**
2. Click on a user who should have SMS access
3. Go to the **Roles** tab
4. Click **Assign Roles**
5. Select the `sms` role
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

### Quick disable for testing:
If you need to temporarily disable role checking:

```toml
# In wrangler.toml
USE_AUTH0_ROLES = "false"  # This disables all role checking
```

## Optional: Create Additional Roles

You can create more roles for different access levels:

1. **admin** - Full access to everything
2. **operator** - Can send/read messages but limited admin features
3. **viewer** - Read-only access (would need code changes)

Just add them to `AUTH0_ALTERNATIVE_SMS_ROLES` in your config.

## Next Steps

1. Consider adding role-based UI elements (hide/show features based on roles)
2. Add audit logging for role-based actions
3. Set up role synchronization with your organization's directory

---

**Need Help?** The current configuration allows any authenticated user to access the dashboard if `USE_AUTH0_ROLES` is set to `"false"`. This is useful for initial testing.