# Auth0 Role-Based Access Control Setup

This guide explains how to configure Auth0 roles for the SMS Dashboard application.

## Overview

Instead of using database permission tables, the SMS Dashboard uses Auth0 roles to control access. Users need specific roles in Auth0 to access SMS functionality.

## Configuration

### 1. Environment Variables

Configure these in `wrangler.toml` or as Cloudflare Worker environment variables:

```toml
# The primary role that grants SMS access
AUTH0_ADMIN_ROLE = "sms-admin"
AUTH0_VIEWER_ROLE = "sms-viewer"


# FULL claim URI holding the roles array (must match your Auth0 Action)
AUTH0_ROLE_NAMESPACE = "https://yourapp.com/roles"

# Only these email domains may log in; addresses must also be email_verified
ALLOWED_EMAIL_DOMAINS = "poloniex.com,bitgc.io,tron.network,htx-inc.com"
```

Role checking is **always on**. There is no setting that disables it: the former
`USE_AUTH0_ROLES` and `AUTH0_ALLOW_NO_ROLES` flags existed only to turn authorization
off, and production shipped with role checking disabled, which granted every
authenticated user full access to all SMS bodies and verification codes. See
[Security Review finding 1](../SECURITY-REVIEW.md).

### 2. Auth0 Setup

#### Option A: Using Auth0 Core Authorization

1. Go to your Auth0 Dashboard
2. Navigate to **User Management** → **Roles**
3. Create both roles: `sms-admin` and `sms-viewer` (names come from `AUTH0_ADMIN_ROLE` / `AUTH0_VIEWER_ROLE`)
4. Assign this role to users who should have SMS access

#### Option B: Using Auth0 Rules (Legacy)

Create a rule to add roles to the token:

```javascript
function addRolesToToken(user, context, callback) {
  // Define your namespace
  const namespace = 'https://yourapp.com/';
  
  // Get user roles
  const roles = (context.authorization || {}).roles || [];
  
  // Add roles to ID token
  context.idToken[namespace + 'roles'] = roles;
  
  // Add roles to Access token
  context.accessToken[namespace + 'roles'] = roles;
  
  callback(null, user, context);
}
```

#### Option C: Using Auth0 Actions (Recommended)

Create a Post-Login Action:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://yourapp.com/';
  
  // Get user roles
  const roles = event.authorization?.roles || [];
  
  // Add roles to tokens
  api.idToken.setCustomClaim(namespace + 'roles', roles);
  api.accessToken.setCustomClaim(namespace + 'roles', roles);
};
```

### 3. Assigning Roles to Users

#### Via Auth0 Dashboard:
1. Go to **User Management** → **Users**
2. Select a user
3. Go to the **Roles** tab
4. Assign `sms-admin` or `sms-viewer`

#### Via Auth0 Management API:
```bash
curl -X POST \
  https://YOUR_DOMAIN.auth0.com/api/v2/users/USER_ID/roles \
  -H 'authorization: Bearer YOUR_MGMT_API_TOKEN' \
  -H 'content-type: application/json' \
  -d '{
    "roles": ["ROLE_ID"]
  }'
```

## How It Works

1. When a user logs in via Auth0, their roles are included in the JWT token
2. The middleware extracts roles from the token
3. For SMS-related endpoints, the middleware checks if the user has one of the allowed roles
4. If the user doesn't have the required role, they get a 403 Forbidden response

## Testing

### With Roles Enabled (Default)

Users must hold one of these two roles. They are mutually exclusive — changing a role via
用户管理 assigns the new one and removes the other.

- `sms-viewer` — read messages, see the SIM list, send SMS
- `sms-admin` — everything above, plus keyword/filter/ICCID editing and user administration

The names come from `AUTH0_ADMIN_ROLE` / `AUTH0_VIEWER_ROLE`; the permission table they
map onto is fixed in `config/auth0-roles.js`. Any role Auth0 reports that is not one of
these two grants nothing — including the retired `sms` role.

### Without Roles

There is no testing mode and no way to grant access without a role. A user with no
matching role is denied at login and at every API call. To give someone access, assign
them `sms-viewer` (or `sms-admin`) in Auth0 — it takes effect on their next login, with no redeploy.

## Permissions Granted

Users with the SMS role automatically get these permissions:
- `phones.read` - View phone numbers and status
- `messages.read` - View SMS messages
- `messages.send` - Send SMS messages

## Troubleshooting

### User gets 403 Forbidden

1. Check if the user has the required role in Auth0
2. Verify the role namespace matches your Auth0 configuration
3. Check if roles are being added to the token (decode the JWT)

### Roles not appearing in token

1. Ensure your Auth0 Rule/Action is active
2. Check the namespace in your Rule/Action matches `AUTH0_ROLE_NAMESPACE`
3. Verify the user actually has roles assigned

### All users have access

This should no longer be possible — the role gate fails closed and has no off switch. If
you do observe it, treat it as a security incident rather than a configuration question:
check that `server/middleware/rbac.js` still denies by default (its tests in
`rbac.test.js` pin this) and that `AUTH0_ROLE_NAMESPACE` points at a claim your Action
actually sets, since a wrong claim yields no roles and therefore denial, not access.