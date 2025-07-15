-- Migration to use ICCID as primary key for phones table
-- This migration:
-- 1. Creates a new phones table with ICCID as primary key
-- 2. Migrates data from old table
-- 3. Updates foreign key references
-- 4. Drops the old table and renames the new one

-- Create new phones table with ICCID as primary key
CREATE TABLE phones_new (
  iccid TEXT PRIMARY KEY,
  number TEXT,
  country TEXT,
  flag TEXT,
  carrier TEXT,
  status TEXT DEFAULT 'active',
  signal INTEGER,
  rssi REAL,
  rsrq REAL,
  rsrp REAL,
  snr REAL,
  operator_name TEXT,
  operator_id TEXT,
  imei TEXT,
  access_tech TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy data from old table, using ICCID as the primary key
-- Only copy rows that have a valid ICCID
INSERT INTO phones_new 
SELECT 
  iccid,  -- Use ICCID as primary key
  number,
  country,
  flag,
  carrier,
  status,
  signal,
  rssi,
  rsrq,
  rsrp,
  snr,
  operator_name,
  operator_id,
  imei,
  access_tech,
  created_at,
  updated_at
FROM phones 
WHERE iccid IS NOT NULL AND iccid \!= '';

-- Create new messages table with updated foreign key reference
CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  phone_iccid TEXT,  -- Changed from phone_id to phone_iccid for clarity
  phone_number TEXT,
  content TEXT NOT NULL,
  source TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  type TEXT DEFAULT 'received',
  verification_code TEXT,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (phone_iccid) REFERENCES phones_new(iccid)
);

-- Migrate messages data
-- Try to match by phone.id = phones.iccid first (for already migrated data)
-- Then try to match by phone.id = phones.id to get the ICCID
INSERT INTO messages_new
SELECT 
  m.id,
  COALESCE(
    -- First try direct ICCID match (for data already using ICCID as ID)
    (SELECT iccid FROM phones WHERE iccid = m.phone_id AND iccid IS NOT NULL),
    -- Then try ID match to get ICCID
    (SELECT iccid FROM phones WHERE id = m.phone_id AND iccid IS NOT NULL)
  ) as phone_iccid,
  m.phone_number,
  m.content,
  m.source,
  m.timestamp,
  m.type,
  m.verification_code,
  m.status,
  m.created_at
FROM messages m
WHERE EXISTS (
  SELECT 1 FROM phones 
  WHERE (phones.iccid = m.phone_id OR phones.id = m.phone_id) 
  AND phones.iccid IS NOT NULL
);

-- Drop old tables and rename new ones
DROP TABLE messages;
DROP TABLE phones;

ALTER TABLE phones_new RENAME TO phones;
ALTER TABLE messages_new RENAME TO messages;

-- Create indexes for performance
CREATE INDEX idx_phones_status ON phones(status);
CREATE INDEX idx_phones_updated_at ON phones(updated_at);
CREATE INDEX idx_messages_phone_iccid ON messages(phone_iccid);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_type ON messages(type);

-- Clean up any orphaned data
DELETE FROM messages WHERE phone_iccid IS NULL;
EOF < /dev/null