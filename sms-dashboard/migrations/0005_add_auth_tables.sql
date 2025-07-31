-- Add Auth0 and RBAC tables to existing database

-- Create groups table
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  is_system BOOLEAN DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create user_groups table
CREATE TABLE IF NOT EXISTS user_groups (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT,
  PRIMARY KEY (user_id, group_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- Create permissions table
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT,
  UNIQUE(resource, action)
);

-- Create group_permissions table
CREATE TABLE IF NOT EXISTS group_permissions (
  group_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT,
  PRIMARY KEY (group_id, permission_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- Create user_permissions table
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted BOOLEAN DEFAULT 1,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT,
  PRIMARY KEY (user_id, permission_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- Create user_settings table
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  language TEXT DEFAULT 'zh-CN',
  timezone TEXT DEFAULT 'Asia/Shanghai',
  notifications_enabled BOOLEAN DEFAULT 1,
  theme TEXT DEFAULT 'light',
  dashboard_layout TEXT,
  phone_filters TEXT,
  message_filters TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
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

-- Insert default groups
INSERT OR IGNORE INTO groups (id, name, description, is_system) VALUES
('admin', 'Administrators', 'Full system access', 1),
('operator', 'Operators', 'Can view and send messages', 1),
('viewer', 'Viewers', 'Read-only access', 1),
('api_user', 'API Users', 'For Orange Pi and external integrations', 1);

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

-- Assign all existing users to operator group
INSERT OR IGNORE INTO user_groups (user_id, group_id, assigned_by)
SELECT id, 'operator', 'migration' FROM users;