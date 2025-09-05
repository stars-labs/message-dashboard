-- Migration 006b: Swap messages tables
-- Date: 2025-09-05
-- Purpose: Step 2 - Replace old messages table with normalized version

-- Create indexes on the new table
CREATE INDEX IF NOT EXISTS idx_messages_normalized_phone_iccid ON messages_normalized(phone_iccid);
CREATE INDEX IF NOT EXISTS idx_messages_normalized_timestamp ON messages_normalized(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_normalized_type ON messages_normalized(type);
CREATE INDEX IF NOT EXISTS idx_messages_normalized_timestamp_type ON messages_normalized(timestamp, type);
CREATE INDEX IF NOT EXISTS idx_messages_normalized_verification ON messages_normalized(verification_code) WHERE verification_code IS NOT NULL;

-- Rename old table for backup
ALTER TABLE messages RENAME TO messages_old_backup;

-- Rename new table to messages
ALTER TABLE messages_normalized RENAME TO messages;

-- Verify the swap
SELECT 'Table swap complete. Message count:' as status, COUNT(*) as count FROM messages;