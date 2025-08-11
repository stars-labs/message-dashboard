-- Migration 012: Add hardware-related columns to phones table
-- These columns were in the Zig daemon but not being stored in the database

-- Add manufacturer column if it doesn't exist
ALTER TABLE phones ADD COLUMN IF NOT EXISTS manufacturer TEXT;

-- Add model column if it doesn't exist  
ALTER TABLE phones ADD COLUMN IF NOT EXISTS model TEXT;

-- Add firmware_revision column if it doesn't exist
ALTER TABLE phones ADD COLUMN IF NOT EXISTS firmware_revision TEXT;

-- Add hardware_revision column if it doesn't exist
ALTER TABLE phones ADD COLUMN IF NOT EXISTS hardware_revision TEXT;

-- Add device_path column if it doesn't exist
ALTER TABLE phones ADD COLUMN IF NOT EXISTS device_path TEXT;

-- Add usb_port column if it doesn't exist
ALTER TABLE phones ADD COLUMN IF NOT EXISTS usb_port INTEGER;

-- Create indexes for new columns that might be queried
CREATE INDEX IF NOT EXISTS idx_phones_manufacturer ON phones(manufacturer);
CREATE INDEX IF NOT EXISTS idx_phones_model ON phones(model);
CREATE INDEX IF NOT EXISTS idx_phones_usb_port ON phones(usb_port);