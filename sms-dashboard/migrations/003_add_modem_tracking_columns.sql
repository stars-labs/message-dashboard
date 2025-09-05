-- Migration: Add modem_index and usb_port columns to modem_state table
-- Date: 2025-09-05
-- Purpose: Track which USB port each modem is connected to for better hardware management

-- Add modem_index column
ALTER TABLE modem_state ADD COLUMN modem_index INTEGER;

-- Add usb_port column  
ALTER TABLE modem_state ADD COLUMN usb_port TEXT;

-- Create index for faster lookups by modem_index
CREATE INDEX IF NOT EXISTS idx_modem_state_index ON modem_state(modem_index);