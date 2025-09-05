-- Migration 006a: Prepare messages table fix (v2)
-- Date: 2025-09-05
-- Purpose: Step 1 - Prepare for removing redundant columns from messages table
-- Fixed: Handle orphaned ICCID references

-- First check for orphaned ICCIDs in messages
SELECT 'Checking for orphaned ICCIDs in messages table...' as status;
SELECT COUNT(DISTINCT m.phone_iccid) as orphaned_iccid_count
FROM messages m
LEFT JOIN sims s ON m.phone_iccid = s.iccid
WHERE m.phone_iccid IS NOT NULL AND s.iccid IS NULL;

-- Update phone_iccid from phone_id where phone_iccid is null
UPDATE messages 
SET phone_iccid = phone_id 
WHERE phone_iccid IS NULL 
  AND phone_id IS NOT NULL;

-- Create new messages table WITHOUT foreign key constraint initially
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
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    -- Foreign key will be added after data cleanup
);

-- Copy data to new table
INSERT OR REPLACE INTO messages_normalized (
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

-- Show count of messages migrated
SELECT 'Messages migrated:' as status, COUNT(*) as count FROM messages_normalized;