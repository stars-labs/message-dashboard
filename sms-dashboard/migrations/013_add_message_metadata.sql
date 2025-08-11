-- Migration 013: Add message metadata columns
-- These columns will store additional SMS metadata from the modem

-- Add sender info for received messages (the phone number that sent the message)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender TEXT;

-- Add SMS center number (SMSC)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS smsc TEXT;

-- Add delivery status for sent messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT;

-- Add delivery timestamp for sent messages  
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;

-- Add message reference number (useful for tracking multi-part messages)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reference_number INTEGER;

-- Add message part info for multi-part messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS part_index INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS total_parts INTEGER;

-- Add PDU mode indicator
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pdu_type TEXT;

-- Add message class (0-3 as per GSM spec)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_class INTEGER;

-- Add storage location where message was stored on SIM
ALTER TABLE messages ADD COLUMN IF NOT EXISTS storage TEXT;

-- Create indexes for commonly queried fields
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_delivery_status ON messages(delivery_status);
CREATE INDEX IF NOT EXISTS idx_messages_reference_number ON messages(reference_number);