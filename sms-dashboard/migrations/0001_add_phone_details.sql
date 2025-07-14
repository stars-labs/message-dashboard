-- Add new columns for phone details
ALTER TABLE phones ADD COLUMN IF NOT EXISTS operator_name TEXT;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS operator_id TEXT;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS imei TEXT;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS access_tech TEXT;