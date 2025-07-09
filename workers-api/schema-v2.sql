-- Enhanced schema with Auth0 integration and RBAC support

-- Drop existing tables if doing a fresh install (comment out for migration)
-- DROP TABLE IF EXISTS user_permissions;
-- DROP TABLE IF EXISTS group_permissions;
-- DROP TABLE IF EXISTS user_groups;
-- DROP TABLE IF EXISTS permissions;
-- DROP TABLE IF EXISTS groups;
-- DROP TABLE IF EXISTS user_settings;
-- DROP TABLE IF EXISTS audit_logs;
-- DROP TABLE IF EXISTS messages;
-- DROP TABLE IF EXISTS phones;
-- DROP TABLE IF EXISTS users;

-- Enhanced users table with Auth0 fields
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, -- Auth0 sub claim (e.g., auth0|123456)
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  nickname TEXT,
  picture TEXT,
  provider TEXT NOT NULL, -- auth0, google-oauth2, github, etc.
  auth0_id TEXT UNIQUE, -- Full Auth0 user ID
  email_verified BOOLEAN DEFAULT FALSE,
  phone_number TEXT,
  phone_verified BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  is_admin BOOLEAN DEFAULT FALSE,
  metadata JSON, -- Store Auth0 user_metadata
  app_metadata JSON, -- Store Auth0 app_metadata
  last_login TIMESTAMP,
  last_ip TEXT,
  login_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User groups for role-based access
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  is_system BOOLEAN DEFAULT FALSE, -- System groups can't be deleted
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User-group relationships
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

-- Permissions definition
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL, -- e.g., 'messages', 'phones', 'users'
  action TEXT NOT NULL, -- e.g., 'read', 'write', 'delete', 'send'
  description TEXT,
  UNIQUE(resource, action)
);

-- Group permissions
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

-- Direct user permissions (overrides group permissions)
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted BOOLEAN DEFAULT TRUE, -- Can be used to explicitly deny
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT,
  PRIMARY KEY (user_id, permission_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id)
);

-- User settings/preferences
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  language TEXT DEFAULT 'zh-CN',
  timezone TEXT DEFAULT 'Asia/Shanghai',
  notifications_enabled BOOLEAN DEFAULT TRUE,
  theme TEXT DEFAULT 'light',
  dashboard_layout JSON,
  phone_filters JSON, -- Saved phone filters
  message_filters JSON, -- Saved message filters
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Enhanced phones table with ownership
CREATE TABLE IF NOT EXISTS phones (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  flag TEXT NOT NULL,
  carrier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  signal INTEGER NOT NULL DEFAULT 0,
  owner_group TEXT, -- Which group owns this phone
  tags JSON, -- Array of tags for filtering
  metadata JSON, -- Additional phone metadata
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_group) REFERENCES groups(id)
);

-- Enhanced messages table with access control
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  phone_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  timestamp TIMESTAMP NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('received', 'sent')),
  verification_code TEXT,
  recipient TEXT,
  status TEXT,
  sent_by TEXT, -- User who sent the message (for sent type)
  visible_to_groups JSON, -- Array of group IDs that can see this message
  metadata JSON, -- Additional message metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (phone_id) REFERENCES phones(id),
  FOREIGN KEY (sent_by) REFERENCES users(id)
);

-- Audit logs for compliance
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL, -- e.g., 'user.login', 'message.send', 'permission.grant'
  resource_type TEXT,
  resource_id TEXT,
  details JSON,
  ip_address TEXT,
  user_agent TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Sessions table (enhanced)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL, -- Store hashed token for security
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_phone_id ON messages(phone_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_sent_by ON messages(sent_by);
CREATE INDEX IF NOT EXISTS idx_phones_status ON phones(status);
CREATE INDEX IF NOT EXISTS idx_phones_owner_group ON phones(owner_group);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_auth0_id ON users(auth0_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_user ON user_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Insert default groups
INSERT OR IGNORE INTO groups (id, name, description, is_system) VALUES
('admin', 'Administrators', 'Full system access', TRUE),
('operator', 'Operators', 'Can view and send messages', TRUE),
('viewer', 'Viewers', 'Read-only access', TRUE),
('api_user', 'API Users', 'For Orange Pi and external integrations', TRUE);

-- Insert default permissions
INSERT OR IGNORE INTO permissions (id, resource, action, description) VALUES
-- User management
('users.read', 'users', 'read', 'View user profiles'),
('users.write', 'users', 'write', 'Create and update users'),
('users.delete', 'users', 'delete', 'Delete users'),
('users.manage_groups', 'users', 'manage_groups', 'Assign users to groups'),

-- Group management
('groups.read', 'groups', 'read', 'View groups'),
('groups.write', 'groups', 'write', 'Create and update groups'),
('groups.delete', 'groups', 'delete', 'Delete groups'),
('groups.manage_permissions', 'groups', 'manage_permissions', 'Assign permissions to groups'),

-- Phone management
('phones.read', 'phones', 'read', 'View phones'),
('phones.write', 'phones', 'write', 'Update phone settings'),
('phones.delete', 'phones', 'delete', 'Remove phones'),

-- Message management
('messages.read', 'messages', 'read', 'View messages'),
('messages.send', 'messages', 'send', 'Send SMS messages'),
('messages.delete', 'messages', 'delete', 'Delete messages'),
('messages.export', 'messages', 'export', 'Export message data'),

-- System settings
('settings.read', 'settings', 'read', 'View system settings'),
('settings.write', 'settings', 'write', 'Modify system settings'),

-- Audit logs
('audit.read', 'audit', 'read', 'View audit logs'),

-- API access
('api.control', 'api', 'control', 'Access control API endpoints');

-- Assign permissions to default groups
-- Admin group - all permissions
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by)
SELECT 'admin', id, 'system' FROM permissions;

-- Operator group - operational permissions
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('operator', 'phones.read', 'system'),
('operator', 'messages.read', 'system'),
('operator', 'messages.send', 'system'),
('operator', 'users.read', 'system');

-- Viewer group - read-only permissions
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('viewer', 'phones.read', 'system'),
('viewer', 'messages.read', 'system');

-- API User group - control API access
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('api_user', 'api.control', 'system'),
('api_user', 'phones.write', 'system'),
('api_user', 'messages.read', 'system');

-- Create views for easier permission checking
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

-- Migration notes:
-- 1. Backup existing data before migration
-- 2. Run migration script to transfer data
-- 3. Update application code to use new schema
-- 4. Test thoroughly before deploying to production