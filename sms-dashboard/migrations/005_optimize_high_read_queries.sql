-- Migration: Optimize queries with high read counts
-- Date: 2025-09-05
-- Purpose: Add indexes and optimize queries that are causing thousands of row reads

-- 1. Add covering index for messages table date queries (for stats)
CREATE INDEX IF NOT EXISTS idx_messages_timestamp_covering 
ON messages(timestamp, type, verification_code);

-- 2. Add index for date-based queries  
CREATE INDEX IF NOT EXISTS idx_messages_date_type 
ON messages(date(timestamp), type);

-- 3. Create a materialized table for device stats (instead of using the view)
-- This will be updated by triggers to avoid constant recalculation
CREATE TABLE IF NOT EXISTS device_stats_cache (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    total_devices INTEGER DEFAULT 0,
    online_devices INTEGER DEFAULT 0,
    offline_devices INTEGER DEFAULT 0,
    error_devices INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    messages_sent INTEGER DEFAULT 0,
    messages_received INTEGER DEFAULT 0,
    messages_today INTEGER DEFAULT 0,
    messages_sent_today INTEGER DEFAULT 0,
    messages_received_today INTEGER DEFAULT 0,
    verified_messages INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert initial stats
INSERT OR IGNORE INTO device_stats_cache (id) VALUES ('singleton');

-- Update stats with current values
UPDATE device_stats_cache SET
    total_messages = (SELECT COUNT(*) FROM messages),
    messages_sent = (SELECT COUNT(*) FROM messages WHERE type = 'sent'),
    messages_received = (SELECT COUNT(*) FROM messages WHERE type = 'received'),
    messages_today = (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now')),
    messages_sent_today = (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'sent'),
    messages_received_today = (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'received'),
    verified_messages = (SELECT COUNT(*) FROM messages WHERE verification_code IS NOT NULL AND type = 'received'),
    last_updated = CURRENT_TIMESTAMP
WHERE id = 'singleton';

-- Create trigger to update message stats on insert
CREATE TRIGGER IF NOT EXISTS update_message_stats_on_insert
AFTER INSERT ON messages
BEGIN
    UPDATE device_stats_cache SET
        total_messages = total_messages + 1,
        messages_sent = messages_sent + CASE WHEN NEW.type = 'sent' THEN 1 ELSE 0 END,
        messages_received = messages_received + CASE WHEN NEW.type = 'received' THEN 1 ELSE 0 END,
        messages_today = messages_today + CASE WHEN date(NEW.timestamp) = date('now') THEN 1 ELSE 0 END,
        messages_sent_today = messages_sent_today + CASE WHEN date(NEW.timestamp) = date('now') AND NEW.type = 'sent' THEN 1 ELSE 0 END,
        messages_received_today = messages_received_today + CASE WHEN date(NEW.timestamp) = date('now') AND NEW.type = 'received' THEN 1 ELSE 0 END,
        verified_messages = verified_messages + CASE WHEN NEW.verification_code IS NOT NULL AND NEW.type = 'received' THEN 1 ELSE 0 END,
        last_updated = CURRENT_TIMESTAMP
    WHERE id = 'singleton';
END;

-- Add index to optimize device_view joins
CREATE INDEX IF NOT EXISTS idx_sims_iccid_active 
ON sims(iccid, status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_messages_phone_iccid 
ON messages(phone_iccid);

CREATE INDEX IF NOT EXISTS idx_iccid_mappings_active 
ON iccid_mappings(iccid, is_active) WHERE is_active = 1;