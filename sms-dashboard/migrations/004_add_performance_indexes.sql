-- Migration: Add performance indexes to reduce high row reads
-- Date: 2025-09-05
-- Purpose: Optimize queries that are reading thousands of rows unnecessarily

-- Index for device_view queries (JOIN operations)
CREATE INDEX IF NOT EXISTS idx_device_view_iccid ON sims(iccid);
CREATE INDEX IF NOT EXISTS idx_device_view_phone_iccid ON messages(phone_iccid);
CREATE INDEX IF NOT EXISTS idx_device_view_active ON sims(status) WHERE status = 'active';

-- Composite index for message type queries
CREATE INDEX IF NOT EXISTS idx_messages_type_timestamp ON messages(type, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp_type ON messages(timestamp, type);

-- Index for verification_code queries
CREATE INDEX IF NOT EXISTS idx_messages_verification ON messages(verification_code) WHERE verification_code IS NOT NULL;

-- Index for today's messages query
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date(timestamp));

-- Index for modem state joins
CREATE INDEX IF NOT EXISTS idx_modem_state_modem_id ON modem_state(modem_id);

-- Index for active SIM and modem lookups
CREATE INDEX IF NOT EXISTS idx_sims_active_modem ON sims(current_modem_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_modems_status ON modems(status) WHERE status = 'connected';