-- Add missing columns for phone details
-- These columns are being sent by the Zig daemon but don't exist in the schema

ALTER TABLE phones ADD COLUMN operator_name TEXT;
ALTER TABLE phones ADD COLUMN operator_id TEXT;
ALTER TABLE phones ADD COLUMN imei TEXT;
ALTER TABLE phones ADD COLUMN access_tech TEXT;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_phones_imei ON phones(imei);
CREATE INDEX IF NOT EXISTS idx_phones_operator_id ON phones(operator_id);