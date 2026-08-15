-- SMS Dashboard Complete Schema
-- This is the current production schema including all migrations

-- Drop existing tables for fresh installation (comment out for migration)
-- DROP TABLE IF EXISTS iccid_mappings;
-- DROP TABLE IF EXISTS messages;
-- DROP TABLE IF EXISTS phones;
-- DROP TABLE IF EXISTS user_permissions;
-- DROP TABLE IF EXISTS group_permissions;
-- DROP TABLE IF EXISTS user_groups;
-- DROP TABLE IF EXISTS permissions;
-- DROP TABLE IF EXISTS groups;
-- DROP TABLE IF EXISTS user_settings;
-- DROP TABLE IF EXISTS audit_logs;
-- DROP TABLE IF EXISTS sessions;
-- DROP TABLE IF EXISTS users;

-- Create phones table with ICCID as primary key
CREATE TABLE IF NOT EXISTS phones (
    iccid TEXT PRIMARY KEY,
    number TEXT,
    country TEXT,
    flag TEXT,
    carrier TEXT,
    status TEXT DEFAULT 'offline',
    signal INTEGER DEFAULT 0,
    rssi INTEGER,
    rsrq INTEGER,
    rsrp INTEGER,
    snr INTEGER,
    operator_name TEXT,
    operator_id TEXT,
    imei TEXT,
    access_tech TEXT,
    modem_index INTEGER,
    sim_index INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create messages table with phone_iccid foreign key
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    phone_iccid TEXT NOT NULL,
    phone_number TEXT,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT CHECK(type IN ('received', 'sent')) NOT NULL,
    recipient TEXT,
    status TEXT DEFAULT 'received',
    verification_code TEXT,
    error_message TEXT,
    sms_id TEXT,
    processing_session_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (phone_iccid) REFERENCES phones(iccid) ON DELETE CASCADE
);

-- ICCID mappings table
CREATE TABLE IF NOT EXISTS iccid_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    iccid TEXT UNIQUE NOT NULL,
    phone_number TEXT NOT NULL,
    carrier TEXT,
    country TEXT,
    notes TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
    login_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Groups table for RBAC
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User-Group associations
CREATE TABLE IF NOT EXISTS user_groups (
    user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    assigned_by TEXT,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, group_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_by) REFERENCES users(id)
);

-- Permissions table
CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    resource TEXT NOT NULL, -- phones, messages, users, etc.
    action TEXT NOT NULL, -- read, write, delete, send, etc.
    description TEXT,
    UNIQUE(resource, action)
);

-- Group permissions
CREATE TABLE IF NOT EXISTS group_permissions (
    group_id TEXT NOT NULL,
    permission_id TEXT NOT NULL,
    granted_by TEXT,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, permission_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id)
);

-- Direct user permissions (overrides)
CREATE TABLE IF NOT EXISTS user_permissions (
    user_id TEXT NOT NULL,
    permission_id TEXT NOT NULL,
    granted BOOLEAN DEFAULT TRUE, -- Can be used to explicitly deny
    granted_by TEXT,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, permission_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id)
);

-- User settings
CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    theme TEXT DEFAULT 'system',
    language TEXT DEFAULT 'en',
    timezone TEXT DEFAULT 'UTC',
    notifications JSON DEFAULT '{}',
    preferences JSON DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    resource_id TEXT,
    details JSON,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Sessions (for non-Auth0 sessions if needed)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_phone_iccid ON messages(phone_iccid);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_phones_status ON phones(status);
CREATE INDEX IF NOT EXISTS idx_phones_number ON phones(number);
CREATE INDEX IF NOT EXISTS idx_phones_modem_index ON phones(modem_index);
CREATE INDEX IF NOT EXISTS idx_phones_sim_index ON phones(sim_index);
CREATE INDEX IF NOT EXISTS idx_iccid_mappings_iccid ON iccid_mappings(iccid);
CREATE INDEX IF NOT EXISTS idx_iccid_mappings_active ON iccid_mappings(is_active);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_auth0_id ON users(auth0_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Insert default groups
INSERT OR IGNORE INTO groups (id, name, description) VALUES
    ('admin', 'Administrators', 'Full system access'),
    ('user', 'Users', 'Standard user access'),
    ('viewer', 'Viewers', 'Read-only access');

-- Insert default permissions
INSERT OR IGNORE INTO permissions (id, resource, action) VALUES
    ('phones.read', 'phones', 'read'),
    ('phones.write', 'phones', 'write'),
    ('phones.delete', 'phones', 'delete'),
    ('messages.read', 'messages', 'read'),
    ('messages.send', 'messages', 'send'),
    ('messages.delete', 'messages', 'delete'),
    ('users.read', 'users', 'read'),
    ('users.write', 'users', 'write'),
    ('users.delete', 'users', 'delete'),
    ('system.admin', 'system', 'admin');

-- Grant permissions to default groups
INSERT OR IGNORE INTO group_permissions (group_id, permission_id) VALUES
    -- Admin gets everything
    ('admin', 'phones.read'),
    ('admin', 'phones.write'),
    ('admin', 'phones.delete'),
    ('admin', 'messages.read'),
    ('admin', 'messages.send'),
    ('admin', 'messages.delete'),
    ('admin', 'users.read'),
    ('admin', 'users.write'),
    ('admin', 'users.delete'),
    ('admin', 'system.admin'),
    -- Users get read/send access
    ('user', 'phones.read'),
    ('user', 'messages.read'),
    ('user', 'messages.send'),
    -- Viewers get read-only
    ('viewer', 'phones.read'),
    ('viewer', 'messages.read');
