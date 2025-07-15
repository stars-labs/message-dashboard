-- Add ICCID mappings table for managing ICCID to phone number associations
CREATE TABLE IF NOT EXISTS iccid_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  iccid TEXT UNIQUE NOT NULL,
  phone_number TEXT NOT NULL,
  carrier TEXT,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_iccid_mappings_iccid ON iccid_mappings(iccid);
CREATE INDEX IF NOT EXISTS idx_iccid_mappings_phone ON iccid_mappings(phone_number);
CREATE INDEX IF NOT EXISTS idx_iccid_mappings_active ON iccid_mappings(is_active);