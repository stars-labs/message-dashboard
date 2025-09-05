-- Migration 006a: Prepare messages table fix
-- Date: 2025-09-05
-- Purpose: Step 1 - Prepare for removing redundant columns from messages table

-- First ensure phone_iccid is populated from phone_id where needed
UPDATE messages 
SET phone_iccid = phone_id 
WHERE phone_iccid IS NULL 
  AND phone_id IS NOT NULL;

-- Create new messages table with proper structure
CREATE TABLE IF NOT EXISTS messages_normalized (
    id TEXT PRIMARY KEY,
    phone_iccid TEXT,
    phone_number TEXT,
    content TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    type TEXT CHECK(type IN ('sent', 'received')),
    status TEXT,
    recipient TEXT,
    verification_code TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (phone_iccid) REFERENCES sims(iccid) ON DELETE RESTRICT
);

-- Copy data to new table
INSERT INTO messages_normalized (
    id, phone_iccid, phone_number, content, timestamp, 
    type, status, recipient, verification_code, created_at, updated_at
)
SELECT 
    id, 
    COALESCE(phone_iccid, phone_id) as phone_iccid,
    phone_number,
    content,
    timestamp,
    type,
    status,
    recipient,
    verification_code,
    created_at,
    updated_at
FROM messages;