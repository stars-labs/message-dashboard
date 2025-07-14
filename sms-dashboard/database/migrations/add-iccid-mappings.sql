-- Add ICCID mappings table for phone number associations
CREATE TABLE IF NOT EXISTS iccid_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  iccid TEXT UNIQUE NOT NULL,
  phone_number TEXT NOT NULL,
  carrier TEXT,
  country TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_iccid_mappings_iccid ON iccid_mappings(iccid);
CREATE INDEX IF NOT EXISTS idx_iccid_mappings_phone ON iccid_mappings(phone_number);