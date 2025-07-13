-- Make required fields nullable for phones without complete data
-- This is a workaround since SQLite doesn't support ALTER COLUMN directly

-- First, rename the old table
ALTER TABLE phones RENAME TO phones_old;

-- Create new table with nullable fields
CREATE TABLE phones (
  id TEXT PRIMARY KEY,
  number TEXT UNIQUE,  -- Now nullable
  country TEXT,        -- Now nullable
  flag TEXT,           -- Now nullable
  carrier TEXT,        -- Now nullable
  status TEXT NOT NULL DEFAULT 'offline',
  signal INTEGER DEFAULT 0,  -- Remove NOT NULL
  owner_group TEXT,
  tags JSON,
  metadata JSON,
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Signal detail columns
  iccid TEXT,
  rssi REAL,
  rsrq REAL,
  rsrp REAL,
  snr REAL,
  FOREIGN KEY (owner_group) REFERENCES groups(id)
);

-- Copy existing data (specify columns to handle schema differences)
INSERT INTO phones (id, number, country, flag, carrier, status, signal, owner_group, tags, metadata, last_message_at, created_at, updated_at, iccid, rssi, rsrq, rsrp, snr)
SELECT id, number, country, flag, carrier, status, signal, owner_group, tags, metadata, last_message_at, created_at, updated_at, 
       iccid, rssi, rsrq, rsrp, snr
FROM phones_old;

-- Drop old table
DROP TABLE phones_old;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_phones_status ON phones(status);
CREATE INDEX IF NOT EXISTS idx_phones_number ON phones(number);
CREATE INDEX IF NOT EXISTS idx_phones_owner_group ON phones(owner_group);
CREATE INDEX IF NOT EXISTS idx_phones_iccid ON phones(iccid);