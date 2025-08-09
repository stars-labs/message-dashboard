-- Migration Validation Script
-- Run this after migration to verify data integrity

-- 1. Check that all tables exist
SELECT 'Checking tables...' as status;

SELECT name FROM sqlite_master 
WHERE type='table' 
AND name IN ('modems', 'sims', 'modem_state', 'modem_sim_history', 'daemon_health')
ORDER BY name;

-- 2. Verify no orphaned SIMs (SIMs without valid modems)
SELECT 'Checking for orphaned SIMs...' as status;

SELECT COUNT(*) as orphaned_sims
FROM sims s
WHERE s.current_modem_id IS NOT NULL
AND NOT EXISTS (
    SELECT 1 FROM modems m WHERE m.equipment_id = s.current_modem_id
);

-- 3. Verify no duplicate equipment IDs
SELECT 'Checking for duplicate equipment IDs...' as status;

SELECT equipment_id, COUNT(*) as count
FROM modems
GROUP BY equipment_id
HAVING COUNT(*) > 1;

-- 4. Verify no duplicate ICCIDs
SELECT 'Checking for duplicate ICCIDs...' as status;

SELECT iccid, COUNT(*) as count
FROM sims
GROUP BY iccid
HAVING COUNT(*) > 1;

-- 5. Check for modems without state records
SELECT 'Checking for modems without state...' as status;

SELECT COUNT(*) as modems_without_state
FROM modems m
WHERE NOT EXISTS (
    SELECT 1 FROM modem_state ms WHERE ms.modem_id = m.equipment_id
);

-- 6. Verify device_view is working
SELECT 'Checking device_view...' as status;

SELECT COUNT(*) as device_count FROM device_view;

-- 7. Check for invalid synthetic IDs
SELECT 'Checking for invalid synthetic IDs...' as status;

SELECT COUNT(*) as invalid_synthetic_ids
FROM modems
WHERE equipment_id LIKE 'MODEM_%'
AND (
    modem_index IS NULL 
    OR equipment_id != 'MODEM_' || modem_index
);

-- 8. Summary statistics
SELECT 'Migration Summary:' as status;

SELECT 
    (SELECT COUNT(*) FROM modems) as total_modems,
    (SELECT COUNT(*) FROM sims) as total_sims,
    (SELECT COUNT(*) FROM modem_state) as total_states,
    (SELECT COUNT(*) FROM device_view) as total_devices,
    (SELECT COUNT(*) FROM modems WHERE status = 'connected') as connected_modems,
    (SELECT COUNT(*) FROM sims WHERE status = 'active') as active_sims;