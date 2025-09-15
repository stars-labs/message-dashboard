-- Migration 010: Fix sim_index synchronization
-- This migration ensures sim_index is properly synchronized between modem_state and sims tables
-- Created: 2025-01-12

-- Step 1: First ensure sim_index column exists in sims table (may already exist from previous migrations)
-- SQLite doesn't support conditional ALTER TABLE, so this might error if column exists - that's OK
-- ALTER TABLE sims ADD COLUMN sim_index INTEGER;

-- Step 2: Sync existing sim_index values from modem_state to sims
-- This handles cases where the daemon updated modem_state but not sims
UPDATE sims 
SET sim_index = (
    SELECT ms.modem_index 
    FROM modem_state ms 
    WHERE ms.modem_id = sims.current_modem_id
    AND ms.modem_index IS NOT NULL
)
WHERE current_modem_id IS NOT NULL 
AND (sim_index IS NULL OR sim_index != (
    SELECT ms.modem_index 
    FROM modem_state ms 
    WHERE ms.modem_id = sims.current_modem_id
    AND ms.modem_index IS NOT NULL
))
AND EXISTS (
    SELECT 1 FROM modem_state ms 
    WHERE ms.modem_id = sims.current_modem_id 
    AND ms.modem_index IS NOT NULL
);

-- Step 3: Create an index for better join performance if not exists
CREATE INDEX IF NOT EXISTS idx_sims_current_modem_sync ON sims(current_modem_id, sim_index);
CREATE INDEX IF NOT EXISTS idx_modem_state_sync ON modem_state(modem_id, modem_index);

-- Step 4: Create a view that always shows the correct sim_index
-- This view can be used by the frontend to always get the right sim_index
DROP VIEW IF EXISTS sims_with_current_index;
CREATE VIEW sims_with_current_index AS
SELECT 
    s.iccid,
    s.phone_number,
    s.current_modem_id,
    s.operator_name,
    s.operator_id,
    s.status,
    -- Use sim_index from sims table if available, otherwise use modem_index from modem_state
    COALESCE(s.sim_index, ms.modem_index) as sim_index,
    s.user_phone_number,
    s.user_carrier,
    s.user_country_code,
    s.user_notes,
    s.user_override_enabled,
    s.last_verified_session,
    s.created_at,
    s.updated_at,
    ms.usb_port,
    ms.signal_percent,
    ms.connection_status
FROM sims s
LEFT JOIN modem_state ms ON s.current_modem_id = ms.modem_id;

-- Step 5: Since D1 (SQLite in Cloudflare) doesn't support triggers that reference other tables,
-- we need to handle synchronization in the application layer.
-- Add a comment to remind developers about this requirement.

-- IMPORTANT: The API handler (control.js) must be updated to:
-- 1. When updating modem_state, also update sim_index in sims table
-- 2. When creating/updating sims, check modem_state for modem_index and sync it

-- Step 6: Log the current state for debugging
-- This will help us see how many records need synchronization
SELECT 
    'SIMs without sim_index' as description,
    COUNT(*) as count
FROM sims 
WHERE sim_index IS NULL AND current_modem_id IS NOT NULL;

SELECT 
    'SIMs with mismatched sim_index' as description,
    COUNT(*) as count
FROM sims s
JOIN modem_state ms ON s.current_modem_id = ms.modem_id
WHERE s.sim_index != ms.modem_index 
AND s.sim_index IS NOT NULL 
AND ms.modem_index IS NOT NULL;