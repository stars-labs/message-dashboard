-- Migration script from v1 to v2 schema
-- Run this after backing up your database

-- Step 1: Add new columns to existing users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS picture TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth0_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata JSON;
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_metadata JSON;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Step 2: Create new tables
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT,
  PRIMARY KEY (user_id, group_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT,
  UNIQUE(resource, action)
);

CREATE TABLE IF NOT EXISTS group_permissions (
  group_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT,
  PRIMARY KEY (group_id, permission_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted BOOLEAN DEFAULT TRUE,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT,
  PRIMARY KEY (user_id, permission_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  language TEXT DEFAULT 'zh-CN',
  timezone TEXT DEFAULT 'Asia/Shanghai',
  notifications_enabled BOOLEAN DEFAULT TRUE,
  theme TEXT DEFAULT 'light',
  dashboard_layout JSON,
  phone_filters JSON,
  message_filters JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details JSON,
  ip_address TEXT,
  user_agent TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Step 3: Add new columns to phones table
ALTER TABLE phones ADD COLUMN IF NOT EXISTS owner_group TEXT;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS tags JSON;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS metadata JSON;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Step 4: Add new columns to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS visible_to_groups JSON;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSON;

-- Step 5: Create new indexes
CREATE INDEX IF NOT EXISTS idx_messages_sent_by ON messages(sent_by);
CREATE INDEX IF NOT EXISTS idx_phones_owner_group ON phones(owner_group);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_auth0_id ON users(auth0_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_user ON user_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Step 6: Insert default groups
INSERT OR IGNORE INTO groups (id, name, description, is_system) VALUES
('admin', 'Administrators', 'Full system access', TRUE),
('operator', 'Operators', 'Can view and send messages', TRUE),
('viewer', 'Viewers', 'Read-only access', TRUE),
('api_user', 'API Users', 'For Orange Pi and external integrations', TRUE);

-- Step 7: Insert default permissions
INSERT OR IGNORE INTO permissions (id, resource, action, description) VALUES
('users.read', 'users', 'read', 'View user profiles'),
('users.write', 'users', 'write', 'Create and update users'),
('users.delete', 'users', 'delete', 'Delete users'),
('users.manage_groups', 'users', 'manage_groups', 'Assign users to groups'),
('groups.read', 'groups', 'read', 'View groups'),
('groups.write', 'groups', 'write', 'Create and update groups'),
('groups.delete', 'groups', 'delete', 'Delete groups'),
('groups.manage_permissions', 'groups', 'manage_permissions', 'Assign permissions to groups'),
('phones.read', 'phones', 'read', 'View phones'),
('phones.write', 'phones', 'write', 'Update phone settings'),
('phones.delete', 'phones', 'delete', 'Remove phones'),
('messages.read', 'messages', 'read', 'View messages'),
('messages.send', 'messages', 'send', 'Send SMS messages'),
('messages.delete', 'messages', 'delete', 'Delete messages'),
('messages.export', 'messages', 'export', 'Export message data'),
('settings.read', 'settings', 'read', 'View system settings'),
('settings.write', 'settings', 'write', 'Modify system settings'),
('audit.read', 'audit', 'read', 'View audit logs'),
('api.control', 'api', 'control', 'Access control API endpoints');

-- Step 8: Assign permissions to groups
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by)
SELECT 'admin', id, 'system' FROM permissions;

INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('operator', 'phones.read', 'system'),
('operator', 'messages.read', 'system'),
('operator', 'messages.send', 'system'),
('operator', 'users.read', 'system');

INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('viewer', 'phones.read', 'system'),
('viewer', 'messages.read', 'system');

INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('api_user', 'api.control', 'system'),
('api_user', 'phones.write', 'system'),
('api_user', 'messages.read', 'system');

-- Step 9: Create permission view
CREATE VIEW IF NOT EXISTS user_effective_permissions AS
SELECT DISTINCT
  u.id as user_id,
  u.email,
  p.id as permission_id,
  p.resource,
  p.action,
  CASE 
    WHEN up.granted IS NOT NULL THEN up.granted
    ELSE 1
  END as granted
FROM users u
LEFT JOIN user_groups ug ON u.id = ug.user_id
LEFT JOIN group_permissions gp ON ug.group_id = gp.group_id
LEFT JOIN permissions p ON gp.permission_id = p.id
LEFT JOIN user_permissions up ON u.id = up.user_id AND p.id = up.permission_id
WHERE u.is_active = TRUE;

-- Step 10: Migrate existing users to operator group by default
INSERT OR IGNORE INTO user_groups (user_id, group_id, assigned_by)
SELECT id, 'operator', 'migration' FROM users;

-- Step 11: Update first user to admin (optional)
-- UPDATE user_groups 
-- SET group_id = 'admin' 
-- WHERE user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1);

-- Migration complete!
-- Remember to test thoroughly before deploying to production