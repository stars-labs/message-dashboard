-- Fix messages table foreign key that references dropped phones table
-- SQLite doesn't support dropping constraints, so we need to recreate the table

-- 1. Create new messages table without the foreign key
CREATE TABLE messages_new (
    id TEXT PRIMARY KEY,
    phone_iccid TEXT NOT NULL,
    phone_number TEXT,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,
    recipient TEXT,
    status TEXT DEFAULT 'received',
    verification_code TEXT,
    sms_id TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ai_verification_code TEXT,
    ai_confidence REAL,
    ai_classification TEXT,
    sim_iccid TEXT,
    modem_id TEXT
);

-- 2. Copy data from old table
INSERT INTO messages_new SELECT * FROM messages;

-- 3. Drop old table
DROP TABLE messages;

-- 4. Rename new table
ALTER TABLE messages_new RENAME TO messages;

-- 5. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_messages_phone_iccid ON messages(phone_iccid);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_verification_code ON messages(verification_code);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);