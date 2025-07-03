-- Create phones table
CREATE TABLE IF NOT EXISTS phones (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  flag TEXT NOT NULL,
  carrier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  signal INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create messages table
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (phone_id) REFERENCES phones(id)
);

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  provider TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_phone_id ON messages(phone_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_phones_status ON phones(status);

-- Insert sample phones for testing (95 phones)
INSERT OR IGNORE INTO phones (id, number, country, flag, carrier, status, signal) VALUES
('SIM_001', '+8613800138001', '中国', '🇨🇳', '中国移动', 'online', 85),
('SIM_002', '+8613800138002', '中国', '🇨🇳', '中国联通', 'online', 92),
('SIM_003', '+8613800138003', '中国', '🇨🇳', '中国电信', 'online', 78),
('SIM_004', '+85291234564', '香港', '🇭🇰', '中国移动香港', 'online', 90),
('SIM_005', '+85291234565', '香港', '🇭🇰', 'csl', 'online', 88),
('SIM_006', '+6598765431', '新加坡', '🇸🇬', 'Singtel', 'online', 95),
('SIM_007', '+6598765432', '新加坡', '🇸🇬', 'StarHub', 'online', 91);

-- Add more phones (you can generate the rest programmatically)