-- Drop and recreate phones table with nullable fields
DROP TABLE IF EXISTS phones;

CREATE TABLE phones (
  id TEXT PRIMARY KEY,
  number TEXT UNIQUE,  -- Nullable
  country TEXT,        -- Nullable
  flag TEXT,           -- Nullable
  carrier TEXT,        -- Nullable
  status TEXT NOT NULL DEFAULT 'offline',
  signal INTEGER DEFAULT 0,
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

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_phones_status ON phones(status);
CREATE INDEX IF NOT EXISTS idx_phones_number ON phones(number);
CREATE INDEX IF NOT EXISTS idx_phones_owner_group ON phones(owner_group);
CREATE INDEX IF NOT EXISTS idx_phones_iccid ON phones(iccid);