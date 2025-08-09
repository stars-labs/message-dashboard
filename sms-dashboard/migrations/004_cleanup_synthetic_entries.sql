-- Migration 004: Clean up synthetic NO_SIM entries
-- These were workarounds for the old architecture and are no longer needed

-- Step 1: Remove synthetic modems (from NO_SIM_MODEM_* entries)
DELETE FROM modems 
WHERE equipment_id LIKE 'SYNTHETIC_%';

-- Step 2: Clean up any orphaned associations
DELETE FROM modem_sim_history 
WHERE modem_id NOT IN (SELECT equipment_id FROM modems);

-- Step 3: Remove old NO_SIM entries from phones table  
DELETE FROM phones 
WHERE iccid LIKE 'NO_SIM_%' 
   OR iccid LIKE 'phone-%'
   OR (iccid IS NULL AND number IS NULL);

-- Step 4: Log cleanup completion
INSERT INTO schema_version (version, description) 
VALUES (4, 'Clean up synthetic NO_SIM entries');

-- Step 5: Show cleanup results
SELECT 'Cleanup Summary:' as info;
SELECT 'Remaining modems: ' || COUNT(*) as stat FROM modems;
SELECT 'Remaining SIMs: ' || COUNT(*) as stat FROM sims;
SELECT 'Remaining phones (old table): ' || COUNT(*) as stat FROM phones;