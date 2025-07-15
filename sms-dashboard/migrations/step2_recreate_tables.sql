-- Step 2: Create new tables with ICCID as primary key

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