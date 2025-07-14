-- Make phone number nullable to support phones without numbers yet
-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table

-- Create new table with nullable number
CREATE TABLE phones_new (
  id TEXT PRIMARY KEY,
  number TEXT UNIQUE,  -- Now nullable
  country TEXT,
  flag TEXT,
  carrier TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  signal INTEGER NOT NULL DEFAULT 0,
  owner_group TEXT,
  tags JSON,
  metadata JSON,
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- New columns for signal details
  iccid TEXT,
  rssi REAL,
  rsrq REAL,
  rsrp REAL,
  snr REAL,
  FOREIGN KEY (owner_group) REFERENCES groups(id)
);

-- Copy existing data
INSERT INTO phones_new (id, number, country, flag, carrier, status, signal, owner_group, tags, metadata, last_message_at, created_at, updated_at, iccid, rssi, rsrq, rsrp, snr)
SELECT id, number, country, flag, carrier, status, signal, owner_group, tags, metadata, last_message_at, created_at, updated_at, iccid, rssi, rsrq, rsrp, snr
FROM phones;

-- Drop old table
DROP TABLE phones;

-- Rename new table
ALTER TABLE phones_new RENAME TO phones;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_phones_status ON phones(status);
CREATE INDEX IF NOT EXISTS idx_phones_number ON phones(number);
CREATE INDEX IF NOT EXISTS idx_phones_owner_group ON phones(owner_group);
CREATE INDEX IF NOT EXISTS idx_phones_iccid ON phones(iccid);