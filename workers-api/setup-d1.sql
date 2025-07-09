-- Setup D1 database with Auth0 and RBAC support
-- This script creates all necessary tables for the enhanced schema

-- Drop existing tables if needed (comment out for production)
-- DROP TABLE IF EXISTS user_permissions;
-- DROP TABLE IF EXISTS group_permissions;
-- DROP TABLE IF EXISTS user_groups;
-- DROP TABLE IF EXISTS permissions;
-- DROP TABLE IF EXISTS groups;
-- DROP TABLE IF EXISTS user_settings;
-- DROP TABLE IF EXISTS audit_logs;
-- DROP TABLE IF EXISTS sessions;

-- Add new columns to existing tables
ALTER TABLE users ADD COLUMN nickname TEXT;
ALTER TABLE users ADD COLUMN picture TEXT;
ALTER TABLE users ADD COLUMN auth0_id TEXT;
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN phone_number TEXT;
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN metadata TEXT;
ALTER TABLE users ADD COLUMN app_metadata TEXT;
ALTER TABLE users ADD COLUMN last_ip TEXT;
ALTER TABLE users ADD COLUMN login_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE phones ADD COLUMN owner_group TEXT;
ALTER TABLE phones ADD COLUMN tags TEXT;
ALTER TABLE phones ADD COLUMN metadata TEXT;
ALTER TABLE phones ADD COLUMN last_message_at TIMESTAMP;
ALTER TABLE phones ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE messages ADD COLUMN sent_by TEXT;
ALTER TABLE messages ADD COLUMN visible_to_groups TEXT;
ALTER TABLE messages ADD COLUMN metadata TEXT;

-- Create groups table
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create user_groups table
CREATE TABLE user_groups (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT,
  PRIMARY KEY (user_id, group_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- Create permissions table
CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT,
  UNIQUE(resource, action)
);

-- Create group_permissions table
CREATE TABLE group_permissions (
  group_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT,
  PRIMARY KEY (group_id, permission_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- Create user_permissions table
CREATE TABLE user_permissions (
  user_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted BOOLEAN DEFAULT TRUE,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT,
  PRIMARY KEY (user_id, permission_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- Create user_settings table
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  language TEXT DEFAULT 'zh-CN',
  timezone TEXT DEFAULT 'Asia/Shanghai',
  notifications_enabled BOOLEAN DEFAULT TRUE,
  theme TEXT DEFAULT 'light',
  dashboard_layout TEXT,
  phone_filters TEXT,
  message_filters TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create audit_logs table
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,
  ip_address TEXT,
  user_agent TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Create sessions table
CREATE TABLE sessions (
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

-- Create indexes
CREATE INDEX idx_messages_sent_by ON messages(sent_by);
CREATE INDEX idx_phones_owner_group ON phones(owner_group);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_auth0_id ON users(auth0_id);
CREATE INDEX idx_user_groups_user ON user_groups(user_id);
CREATE INDEX idx_user_groups_group ON user_groups(group_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Insert default groups
INSERT OR IGNORE INTO groups (id, name, description, is_system) VALUES
('admin', 'Administrators', 'Full system access', TRUE),
('operator', 'Operators', 'Can view and send messages', TRUE),
('viewer', 'Viewers', 'Read-only access', TRUE),
('api_user', 'API Users', 'For Orange Pi and external integrations', TRUE);

-- Insert default permissions
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

-- Assign permissions to admin group
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by)
SELECT 'admin', id, 'system' FROM permissions;

-- Assign permissions to operator group
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('operator', 'phones.read', 'system'),
('operator', 'messages.read', 'system'),
('operator', 'messages.send', 'system'),
('operator', 'users.read', 'system');

-- Assign permissions to viewer group
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('viewer', 'phones.read', 'system'),
('viewer', 'messages.read', 'system');

-- Assign permissions to api_user group
INSERT OR IGNORE INTO group_permissions (group_id, permission_id, granted_by) VALUES
('api_user', 'api.control', 'system'),
('api_user', 'phones.write', 'system'),
('api_user', 'messages.read', 'system');

-- Create user permissions view
CREATE VIEW user_effective_permissions AS
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