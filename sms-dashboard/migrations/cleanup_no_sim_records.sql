-- Clean up invalid NO_SIM records from database
-- These were created by synthetic modem tracking logic that shouldn't exist

-- 1. Remove from sims table (should not be there at all)
DELETE FROM sims WHERE iccid LIKE 'NO_SIM_%';

-- 2. Remove synthetic modems from modems table
DELETE FROM modems WHERE equipment_id LIKE 'SYNTHETIC_%';

-- 3. Show cleanup results
SELECT 'Cleanup complete' as status;