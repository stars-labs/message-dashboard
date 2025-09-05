-- Migration 006: Fix Database Normalization Issues
-- Date: 2025-09-05
-- Purpose: Fix 3NF violations in messages and iccid_mappings tables
-- 
-- IMPORTANT: Run backup before applying this migration!
-- Rollback script available at: 006_fix_normalization_rollback.sql

-- ============================================
-- STEP 1: Data Analysis and Preparation
-- ============================================

-- Check for any unique data in iccid_mappings that doesn't exist in sims
SELECT 'Checking iccid_mappings for unique data...' as status;

-- Create temporary table to store mapping data we might need to preserve
CREATE TEMP TABLE IF NOT EXISTS iccid_mappings_unique AS
SELECT DISTINCT
    im.iccid,
    im.phone_number,
    im.carrier,
    im.country
FROM iccid_mappings im
LEFT JOIN sims s ON im.iccid = s.iccid
WHERE im.is_active = 1
  AND (
    (im.phone_number IS NOT NULL AND im.phone_number != s.phone_number) OR
    (im.carrier IS NOT NULL AND im.carrier != s.carrier) OR
    (im.country IS NOT NULL AND im.country != s.country_code)
  );

-- ============================================
-- STEP 2: Fix messages table (Remove redundant columns)
-- ============================================

SELECT 'Fixing messages table - removing redundant columns...' as status;

-- First, ensure phone_iccid is populated where phone_id exists but phone_iccid is null
UPDATE messages 
SET phone_iccid = phone_id 
WHERE phone_iccid IS NULL 
  AND phone_id IS NOT NULL;

-- Create a new messages table with proper structure (SQLite doesn't support DROP COLUMN easily)
CREATE TABLE messages_new (
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

-- Copy data from old table to new table
INSERT INTO messages_new (
    id, phone_iccid, phone_number, content, timestamp, 
    type, status, recipient, verification_code, created_at, updated_at
)
SELECT 
    id, 
    COALESCE(phone_iccid, phone_id) as phone_iccid,  -- Use phone_id as fallback
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

-- Recreate indexes on new table
CREATE INDEX IF NOT EXISTS idx_messages_phone_iccid_new ON messages_new(phone_iccid);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp_new ON messages_new(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_type_new ON messages_new(type);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp_type_new ON messages_new(timestamp, type);
CREATE INDEX IF NOT EXISTS idx_messages_verification_new ON messages_new(verification_code) WHERE verification_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_date_new ON messages_new(date(timestamp));
CREATE INDEX IF NOT EXISTS idx_messages_timestamp_covering_new ON messages_new(timestamp, type, verification_code);
CREATE INDEX IF NOT EXISTS idx_messages_date_type_new ON messages_new(date(timestamp), type);

-- ============================================
-- STEP 3: Update foreign key references
-- ============================================

SELECT 'Updating foreign key references...' as status;

-- Update message_tags to reference new messages table
DROP TABLE IF EXISTS message_tags_temp;
CREATE TABLE message_tags_temp AS SELECT * FROM message_tags;

DROP TABLE IF EXISTS message_tags;
CREATE TABLE message_tags (
    message_id TEXT NOT NULL,
    keyword_tag_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, keyword_tag_id, position),
    FOREIGN KEY (message_id) REFERENCES messages_new(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
);

INSERT INTO message_tags SELECT * FROM message_tags_temp;
DROP TABLE message_tags_temp;

-- Update ai_insights to reference new messages table
DROP TABLE IF EXISTS ai_insights_temp;
CREATE TABLE ai_insights_temp AS SELECT * FROM ai_insights;

DROP TABLE IF EXISTS ai_insights;
CREATE TABLE ai_insights (
    message_id TEXT PRIMARY KEY,
    verification_code TEXT,
    sender_category TEXT,
    message_category TEXT,
    confidence_score REAL,
    extracted_entities TEXT,
    embedding_generated BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages_new(id) ON DELETE CASCADE
);

INSERT INTO ai_insights SELECT * FROM ai_insights_temp;
DROP TABLE ai_insights_temp;

-- Update message_embeddings to reference new messages table
DROP TABLE IF EXISTS message_embeddings_temp;
CREATE TABLE message_embeddings_temp AS SELECT * FROM message_embeddings;

DROP TABLE IF EXISTS message_embeddings;
CREATE TABLE message_embeddings (
    message_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    model_version TEXT DEFAULT 'text-embedding-ada-002',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages_new(id) ON DELETE CASCADE
);

INSERT INTO message_embeddings SELECT * FROM message_embeddings_temp;
DROP TABLE message_embeddings_temp;

-- ============================================
-- STEP 4: Swap tables
-- ============================================

SELECT 'Swapping tables...' as status;

-- Rename old table for rollback purposes
ALTER TABLE messages RENAME TO messages_old_backup;

-- Rename new table to messages
ALTER TABLE messages_new RENAME TO messages;

-- ============================================
-- STEP 5: Handle iccid_mappings migration
-- ============================================

SELECT 'Migrating iccid_mappings data to sims table...' as status;

-- Update sims table with any unique mapping data
UPDATE sims 
SET 
    phone_number = COALESCE(
        (SELECT phone_number FROM iccid_mappings_unique WHERE iccid = sims.iccid),
        sims.phone_number
    ),
    carrier = COALESCE(
        (SELECT carrier FROM iccid_mappings_unique WHERE iccid = sims.iccid),
        sims.carrier
    ),
    country_code = COALESCE(
        (SELECT country FROM iccid_mappings_unique WHERE iccid = sims.iccid),
        sims.country_code
    )
WHERE iccid IN (SELECT iccid FROM iccid_mappings_unique);

-- Rename iccid_mappings table (don't drop it immediately in case we need to rollback)
ALTER TABLE iccid_mappings RENAME TO iccid_mappings_deprecated;

-- ============================================
-- STEP 6: Add CHECK constraints for data integrity
-- ============================================

SELECT 'Adding CHECK constraints...' as status;

-- Note: SQLite doesn't support ALTER TABLE ADD CONSTRAINT for CHECK constraints
-- These would need to be added during table creation
-- Document them for future reference:
-- modems.status CHECK (status IN ('connected', 'disconnected', 'error', 'registered', 'sim-missing'))
-- sims.status CHECK (status IN ('active', 'inactive', 'removed'))
-- messages.type CHECK (type IN ('sent', 'received'))

-- ============================================
-- STEP 7: Update views that reference old columns
-- ============================================

SELECT 'Updating views...' as status;

-- The device_view should still work as it references sims and modems directly
-- But let's verify it still works
SELECT COUNT(*) as device_view_count FROM device_view;

-- ============================================
-- STEP 8: Clean up temporary tables
-- ============================================

SELECT 'Cleaning up temporary tables...' as status;

DROP TABLE IF EXISTS iccid_mappings_unique;

-- ============================================
-- STEP 9: Verification
-- ============================================

SELECT 'Running verification checks...' as status;

-- Check message count matches
SELECT 
    (SELECT COUNT(*) FROM messages) as new_message_count,
    (SELECT COUNT(*) FROM messages_old_backup) as old_message_count;

-- Check foreign key integrity
SELECT 
    COUNT(*) as orphaned_messages
FROM messages m
LEFT JOIN sims s ON m.phone_iccid = s.iccid
WHERE m.phone_iccid IS NOT NULL 
  AND s.iccid IS NULL;

-- Check that all message relationships are preserved
SELECT 
    (SELECT COUNT(*) FROM message_tags) as message_tags_count,
    (SELECT COUNT(*) FROM ai_insights) as ai_insights_count,
    (SELECT COUNT(*) FROM message_embeddings) as embeddings_count;

SELECT '✅ Migration 006 completed successfully!' as status;
SELECT 'Old tables preserved with _old_backup and _deprecated suffixes for rollback' as info;