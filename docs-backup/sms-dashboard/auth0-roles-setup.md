# Auth0 Role-Based Access Control Setup

This guide explains how to configure Auth0 roles for the SMS Dashboard application.

## Overview

Instead of using database permission tables, the SMS Dashboard uses Auth0 roles to control access. Users need specific roles in Auth0 to access SMS functionality.

## Configuration

### 1. Environment Variables

Configure these in `wrangler.toml` or as Cloudflare Worker environment variables:

```toml
# Enable/disable Auth0 role checking
USE_AUTH0_ROLES = "true"  # Set to "false" to disable role checking

# The primary role that grants SMS access
AUTH0_SMS_ROLE = "sms"

# Additional roles that grant SMS access (comma-separated)
AUTH0_ALTERNATIVE_SMS_ROLES = "admin,operator"

# Where to find roles in the Auth0 token
AUTH0_ROLE_NAMESPACE = "https://yourapp.com/roles"

# Allow users without roles (testing only)
AUTH0_ALLOW_NO_ROLES = "false"
```

### 2. Auth0 Setup

#### Option A: Using Auth0 Core Authorization

1. Go to your Auth0 Dashboard
2. Navigate to **User Management** → **Roles**
3. Create a new role called `sms` (or whatever you set in `AUTH0_SMS_ROLE`)
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
4. Assign the `sms` role (or your configured role)

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

Users must have one of these roles to access SMS features:
- `sms` (primary role)
- `admin` (alternative role)
- `operator` (alternative role)

### Without Roles (Testing Mode)

Set these environment variables:
```toml
USE_AUTH0_ROLES = "false"  # Disables role checking
# OR
AUTH0_ALLOW_NO_ROLES = "true"  # Allows users without any roles
```

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

Check if `USE_AUTH0_ROLES` is set to `"true"` (not `true` without quotes)