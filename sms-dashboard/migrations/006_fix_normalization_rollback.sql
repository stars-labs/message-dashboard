-- Rollback script for Migration 006: Fix Database Normalization Issues
-- Date: 2025-09-05
-- Purpose: Rollback normalization changes if needed

-- ============================================
-- STEP 1: Restore messages table
-- ============================================

SELECT 'Rolling back messages table changes...' as status;

-- Drop the new messages table
DROP TABLE IF EXISTS messages;

-- Restore the original messages table
ALTER TABLE messages_old_backup RENAME TO messages;

-- ============================================
-- STEP 2: Restore iccid_mappings table
-- ============================================

SELECT 'Restoring iccid_mappings table...' as status;

-- Restore the iccid_mappings table
ALTER TABLE iccid_mappings_deprecated RENAME TO iccid_mappings;

-- ============================================
-- STEP 3: Restore foreign key relationships
-- ============================================

SELECT 'Restoring foreign key relationships...' as status;

-- Recreate message_tags with original foreign keys
DROP TABLE IF EXISTS message_tags_new;
CREATE TABLE message_tags_new (
    message_id TEXT NOT NULL,
    keyword_tag_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, keyword_tag_id, position),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
);

INSERT INTO message_tags_new SELECT * FROM message_tags;
DROP TABLE message_tags;
ALTER TABLE message_tags_new RENAME TO message_tags;

-- Recreate ai_insights with original foreign keys
DROP TABLE IF EXISTS ai_insights_new;
CREATE TABLE ai_insights_new (
    message_id TEXT PRIMARY KEY,
    verification_code TEXT,
    sender_category TEXT,
    message_category TEXT,
    confidence_score REAL,
    extracted_entities TEXT,
    embedding_generated BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

INSERT INTO ai_insights_new SELECT * FROM ai_insights;
DROP TABLE ai_insights;
ALTER TABLE ai_insights_new RENAME TO ai_insights;

-- Recreate message_embeddings with original foreign keys
DROP TABLE IF EXISTS message_embeddings_new;
CREATE TABLE message_embeddings_new (
    message_id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    model_version TEXT DEFAULT 'text-embedding-ada-002',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

INSERT INTO message_embeddings_new SELECT * FROM message_embeddings;
DROP TABLE message_embeddings;
ALTER TABLE message_embeddings_new RENAME TO message_embeddings;

-- ============================================
-- STEP 4: Verification
-- ============================================

SELECT 'Running rollback verification...' as status;

-- Verify tables exist
SELECT 
    (SELECT COUNT(*) FROM messages) as messages_count,
    (SELECT COUNT(*) FROM iccid_mappings) as iccid_mappings_count;

-- Verify relationships
SELECT 
    (SELECT COUNT(*) FROM message_tags) as message_tags_count,
    (SELECT COUNT(*) FROM ai_insights) as ai_insights_count,
    (SELECT COUNT(*) FROM message_embeddings) as embeddings_count;

SELECT '✅ Rollback completed successfully!' as status;
SELECT 'Database has been restored to pre-migration state' as info;