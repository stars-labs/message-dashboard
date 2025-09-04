# Authorization and User Groups Configuration Guide

## Overview

The SMS Dashboard implements a comprehensive Role-Based Access Control (RBAC) system with:
- Auth0 authentication
- User groups with configurable permissions
- Fine-grained access control
- Audit logging
- Domain-based access restrictions

## Database Schema Changes

### New Tables
1. **groups** - Define user roles
2. **user_groups** - User-to-group assignments
3. **permissions** - Available system permissions
4. **group_permissions** - Permissions assigned to groups
5. **user_permissions** - Direct user permission overrides
6. **user_settings** - User preferences
7. **audit_logs** - Track all user actions
8. **sessions** - Enhanced session management

### Default Groups

| Group | Description | Default Permissions |
|-------|-------------|-------------------|
| **admin** | Full system access | All permissions |
| **operator** | Can view and send messages | phones.read, messages.read, messages.send, users.read |
| **viewer** | Read-only access | phones.read, messages.read |
| **api_user** | For Orange Pi integration | api.control, phones.write, messages.read |

## Permission System

### Available Permissions

#### User Management
- `users.read` - View user profiles
- `users.write` - Create and update users
- `users.delete` - Delete users
- `users.manage_groups` - Assign users to groups

#### Group Management
- `groups.read` - View groups
- `groups.write` - Create and update groups
- `groups.delete` - Delete groups
- `groups.manage_permissions` - Assign permissions to groups

#### Phone Management
- `phones.read` - View phones
- `phones.write` - Update phone settings
- `phones.delete` - Remove phones

#### Message Management
- `messages.read` - View messages
- `messages.send` - Send SMS messages
- `messages.delete` - Delete messages
- `messages.export` - Export message data

#### System
- `settings.read` - View system settings
- `settings.write` - Modify system settings
- `audit.read` - View audit logs
- `api.control` - Access control API endpoints

## Configuration

### Environment Variables

Add these to your `wrangler.toml` [vars] section:

```toml
[vars]
# Default group for new users (default: "viewer")
DEFAULT_USER_GROUP = "viewer"

# Comma-separated list of allowed email domains
# Leave empty to allow all domains
ALLOWED_EMAIL_DOMAINS = "yourcompany.com,partner.com"

# Auth0 configuration
AUTH0_DOMAIN = "your-tenant.auth0.com"
```

### First-Time Setup

1. **Deploy the schema migration**:
   ```bash
   # Apply new schema
   wrangler d1 execute sms-dashboard --file=migrate-schema.sql
   ```

2. **Assign first admin**:
   ```bash
   # Get the first user's ID
   wrangler d1 execute sms-dashboard --command="SELECT id, email FROM users LIMIT 1"
   
   # Make them admin
   wrangler d1 execute sms-dashboard --command="UPDATE users SET is_admin = TRUE WHERE id = 'USER_ID_HERE'"
   ```

3. **Configure Auth0 Rules** (optional):
   
   In Auth0 Dashboard → Auth Pipeline → Rules, add:
   
   ```javascript
   function (user, context, callback) {
     // Auto-assign admin role based on email
     const adminEmails = ['admin@yourcompany.com'];
     
     if (adminEmails.includes(user.email)) {
       user.app_metadata = user.app_metadata || {};
       user.app_metadata.role = 'admin';
     }
     
     callback(null, user, context);
   }
   ```

## User Management

### API Endpoints

#### List Users
```bash
GET /api/users?limit=50&offset=0&search=john&group=admin
Authorization: Bearer <token>
```

#### Get User Details
```bash
GET /api/users/{userId}
Authorization: Bearer <token>
```

#### Update User
```bash
PUT /api/users/{userId}
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "John Doe",
  "is_active": true,
  "is_admin": false,
  "groups": ["operator", "viewer"]
}
```

#### Delete User
```bash
DELETE /api/users/{userId}
Authorization: Bearer <token>
```

### Group Management

#### List Groups
```bash
GET /api/groups
Authorization: Bearer <token>
```

#### Create Group
```bash
POST /api/groups
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Support Team",
  "description": "Customer support staff",
  "permissions": ["messages.read", "messages.send", "phones.read"]
}
```

#### Update Group
```bash
PUT /api/groups/{groupId}
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Updated Name",
  "description": "Updated description",
  "permissions": ["messages.read"]
}
```

#### Add/Remove Group Members
```bash
# Add members
POST /api/groups/{groupId}/members
{
  "userIds": ["user1", "user2"]
}

# Remove members
DELETE /api/groups/{groupId}/members
{
  "userIds": ["user1"]
}
```

## Access Control Examples

### Phone Ownership
Phones can be assigned to specific groups:

```sql
-- Assign phones to support team
UPDATE phones 
SET owner_group = 'support_team'
WHERE country = 'China';
```

### Message Visibility
Control which groups can see specific messages:

```sql
-- Make sensitive messages visible only to admins
UPDATE messages 
SET visible_to_groups = '["admin"]'
WHERE content LIKE '%confidential%';
```

## Audit Logging

All sensitive actions are logged:

```sql
-- View recent admin actions
SELECT * FROM audit_logs 
WHERE action LIKE 'user.%' OR action LIKE 'group.%'
ORDER BY timestamp DESC
LIMIT 50;

-- View login attempts
SELECT * FROM audit_logs 
WHERE action = 'user.login'
ORDER BY timestamp DESC;
```

## Security Best Practices

1. **Principle of Least Privilege**
   - Assign users to the most restrictive group that allows them to do their job
   - Use viewer group by default for new users

2. **Regular Audits**
   - Review group memberships monthly
   - Check audit logs for suspicious activity
   - Remove inactive users

3. **Domain Restrictions**
   - Use `ALLOWED_EMAIL_DOMAINS` to restrict access
   - Consider using Auth0 rules for more complex logic

4. **API Key Security**
   - Rotate API keys regularly
   - Use different keys for different Orange Pi devices
   - Monitor API usage in audit logs

## Migration from Old System

If migrating from the basic auth system:

1. **Backup your database**
   ```bash
   wrangler d1 export sms-dashboard --output=backup.sql
   ```

2. **Run migration**
   ```bash
   wrangler d1 execute sms-dashboard --file=migrate-schema.sql
   ```

3. **Verify data**
   ```bash
   # Check users were assigned to groups
   wrangler d1 execute sms-dashboard --command="SELECT u.email, GROUP_CONCAT(g.name) as groups FROM users u JOIN user_groups ug ON u.id = ug.user_id JOIN groups g ON ug.group_id = g.id GROUP BY u.id"
   ```

## Troubleshooting

### User Can't Access Features
1. Check user is active: `SELECT is_active FROM users WHERE email = ?`
2. Check user's groups: `SELECT * FROM user_groups WHERE user_id = ?`
3. Check group permissions: `SELECT * FROM group_permissions WHERE group_id = ?`
4. Check audit logs for permission denials

### New User Can't Login
1. Check `ALLOWED_EMAIL_DOMAINS` setting
2. Verify Auth0 application is configured correctly
3. Check if user was created in database
4. Review audit logs for login attempts

### Permission Changes Not Working
1. Clear any cached sessions
2. User may need to logout and login again
3. Check the `user_effective_permissions` view

## Frontend Integration

Update your frontend to handle permissions:

```javascript
// Check if user can perform action
if (user.permissions.includes('messages.send')) {
  // Show send button
}

// Handle permission errors
try {
  await api.sendMessage(data);
} catch (error) {
  if (error.status === 403) {
    alert('You do not have permission to send messages');
  }
}
```

## Monitoring

Track system usage:

```sql
-- Most active users
SELECT u.email, COUNT(*) as actions
FROM audit_logs al
JOIN users u ON al.user_id = u.id
WHERE al.timestamp > datetime('now', '-7 days')
GROUP BY u.email
ORDER BY actions DESC;

-- Permission denial rate
SELECT 
  DATE(timestamp) as day,
  COUNT(*) as denials
FROM audit_logs
WHERE action = 'permission.denied'
GROUP BY day
ORDER BY day DESC;
```