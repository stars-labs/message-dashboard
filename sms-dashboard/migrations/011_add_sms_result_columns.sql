-- Add missing columns for SMS result tracking
-- These columns are used by the /api/control/sms-result endpoint

-- Add error_message column to track SMS send failures
ALTER TABLE messages ADD COLUMN error_message TEXT;

-- Add sms_id column to track ModemManager SMS IDs
ALTER TABLE messages ADD COLUMN sms_id TEXT;
