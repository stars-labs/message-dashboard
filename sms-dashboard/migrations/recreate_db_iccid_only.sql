-- Drop and recreate database with ICCID as the sole primary key
-- This script removes the dual id/iccid field structure

-- Drop existing tables
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS phones;

-- Create phones table with ICCID as primary key
CREATE TABLE phones (
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create messages table with phone_iccid foreign key
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    phone_iccid TEXT NOT NULL,
    phone_number TEXT,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT CHECK(type IN ('received', 'sent')) NOT NULL,
    recipient TEXT,
    status TEXT DEFAULT 'received',
    verification_code TEXT,
    FOREIGN KEY (phone_iccid) REFERENCES phones(iccid) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX idx_messages_phone_iccid ON messages(phone_iccid);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_phones_status ON phones(status);
CREATE INDEX idx_phones_number ON phones(number);

-- Insert sample data for testing (optional)
-- This can be removed in production
INSERT INTO phones (iccid, number, country, flag, carrier, status) VALUES
    ('89860040191833946266', '+8615000000001', 'CN', '🇨🇳', 'China Mobile', 'online'),
    ('89860040191833946267', '+8615000000002', 'CN', '🇨🇳', 'China Mobile', 'online'),
    ('89860040191833946268', '+8615000000003', 'CN', '🇨🇳', 'China Mobile', 'online'),
    ('89860040191833946269', '+8615000000004', 'CN', '🇨🇳', 'China Mobile', 'online'),
    ('89860040191833946270', '+8615000000005', 'CN', '🇨🇳', 'China Mobile', 'online');