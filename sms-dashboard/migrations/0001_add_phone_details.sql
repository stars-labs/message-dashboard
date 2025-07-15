-- Add new columns for phone details if they don't exist
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we need to handle this differently
-- These commands will fail if columns already exist, which is fine
ALTER TABLE phones ADD COLUMN operator_name TEXT;
ALTER TABLE phones ADD COLUMN operator_id TEXT;
ALTER TABLE phones ADD COLUMN imei TEXT;
ALTER TABLE phones ADD COLUMN access_tech TEXT;