-- Cleanup Script: Remove Fake MODEM_ Entries and Fix Relationships
-- Purpose: Clean up corrupted data caused by fake modem ID generation
-- IMPORTANT: Run analyze-fake-modems.sql FIRST to understand the scope
-- WARNING: This script modifies data. Test on local database first!
--
-- Usage:
--   1. Backup database: npx wrangler d1 backup sms-dashboard
--   2. Run analysis: npx wrangler d1 execute sms-dashboard --remote --file=sql/analyze-fake-modems.sql > analysis.txt
--   3. Review analysis.txt carefully
--   4. Run cleanup: npx wrangler d1 execute sms-dashboard --remote --file=sql/cleanup-fake-modems.sql
--   5. Verify: npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%'"

-- ============================================================================
-- STEP 1: Create Archive Tables (Audit Trail)
-- ============================================================================

-- Archive fake modems before deletion
CREATE TABLE IF NOT EXISTS modems_archive_fake (
    equipment_id TEXT,
    manufacturer TEXT,
    model TEXT,
    firmware_revision TEXT,
    hardware_revision TEXT,
    device_path TEXT,
    usb_port INTEGER,
    modem_index INTEGER,
    status TEXT,
    last_seen TIMESTAMP,
    first_seen TIMESTAMP,
    error_count INTEGER,
    last_error TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cleanup_reason TEXT
);

-- Archive affected SIM relationships
CREATE TABLE IF NOT EXISTS sims_archive_fake_relationships (
    iccid TEXT,
    phone_number TEXT,
    fake_modem_id TEXT,
    corrected_modem_id TEXT,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    correction_method TEXT
);

-- Archive affected modem-SIM history
CREATE TABLE IF NOT EXISTS modem_sim_history_archive_fake (
    id INTEGER,
    modem_id TEXT,
    sim_iccid TEXT,
    inserted_at TIMESTAMP,
    removed_at TIMESTAMP,
    signal_quality INTEGER,
    network_type TEXT,
    access_tech TEXT,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

SELECT 'Archive tables created' as status;

-- ============================================================================
-- STEP 2: Archive Fake Modem Data
-- ============================================================================

INSERT INTO modems_archive_fake
SELECT
    *,
    CURRENT_TIMESTAMP as archived_at,
    'Fake equipment_id with MODEM_ prefix' as cleanup_reason
FROM modems
WHERE equipment_id LIKE 'MODEM_%';

SELECT 'Archived ' || changes() || ' fake modem records' as status;

-- ============================================================================
-- STEP 3: Archive Affected SIM Relationships (Before Correction)
-- ============================================================================

INSERT INTO sims_archive_fake_relationships (iccid, phone_number, fake_modem_id, corrected_modem_id, correction_method)
SELECT
    s.iccid,
    s.phone_number,
    s.current_modem_id,
    NULL, -- Will be filled in Step 4
    'pending' as correction_method
FROM sims s
WHERE s.current_modem_id LIKE 'MODEM_%';

SELECT 'Archived ' || changes() || ' SIM relationships with fake modems' as status;

-- ============================================================================
-- STEP 4: Attempt to Map Fake Modems to Real Hardware (Smart Correction)
-- ============================================================================

-- Strategy: For each SIM pointing to fake modem, find the real modem that was:
-- 1. Active/connected at approximately the same time (within 5 minutes)
-- 2. Has the same USB port (if available)
-- 3. Has the best temporal correlation

-- Create temporary mapping table
CREATE TEMP TABLE fake_to_real_mapping AS
SELECT DISTINCT
    s.iccid,
    s.current_modem_id as fake_modem_id,
    first_value(m.equipment_id) OVER (
        PARTITION BY s.iccid
        ORDER BY
            -- Prioritize exact USB port match
            CASE WHEN ms.usb_port = fake_ms.usb_port THEN 0 ELSE 1 END,
            -- Then by time proximity
            ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)),
            -- Then by signal strength (prefer stronger signal)
            ms.signal_percent DESC
    ) as real_modem_id,
    ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) as time_diff,
    CASE
        WHEN ms.usb_port = fake_ms.usb_port THEN 'usb_port_match'
        WHEN ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) < 60 THEN 'temporal_high_confidence'
        WHEN ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) < 300 THEN 'temporal_medium_confidence'
        ELSE 'temporal_low_confidence'
    END as match_method
FROM sims s
CROSS JOIN modems m
LEFT JOIN modem_state fake_ms ON s.current_modem_id = fake_ms.modem_id
LEFT JOIN modem_state ms ON m.equipment_id = ms.modem_id
WHERE s.current_modem_id LIKE 'MODEM_%'
  AND m.equipment_id NOT LIKE 'MODEM_%'
  AND m.equipment_id NOT LIKE 'SIM_%'
  AND m.status IN ('connected', 'online', 'active', 'registered')
  -- Within 10 minute window
  AND ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) < 600;

SELECT 'Created mapping for ' || COUNT(*) || ' SIMs with fake modems' as status
FROM fake_to_real_mapping;

-- Show mapping summary before applying
SELECT
    'MAPPING PREVIEW: ' ||
    COUNT(*) || ' SIMs will be remapped, ' ||
    SUM(CASE WHEN match_method = 'usb_port_match' THEN 1 ELSE 0 END) || ' by USB port, ' ||
    SUM(CASE WHEN match_method LIKE 'temporal_high%' THEN 1 ELSE 0 END) || ' by high confidence temporal, ' ||
    SUM(CASE WHEN match_method LIKE 'temporal_medium%' THEN 1 ELSE 0 END) || ' by medium confidence temporal, ' ||
    SUM(CASE WHEN match_method LIKE 'temporal_low%' THEN 1 ELSE 0 END) || ' by low confidence temporal'
    as mapping_summary
FROM fake_to_real_mapping;

-- ============================================================================
-- STEP 5: Update SIM Relationships (Apply Corrections)
-- ============================================================================

-- Update SIMs with high confidence mappings (usb_port or temporal_high)
UPDATE sims
SET current_modem_id = (
    SELECT real_modem_id
    FROM fake_to_real_mapping
    WHERE fake_to_real_mapping.iccid = sims.iccid
      AND match_method IN ('usb_port_match', 'temporal_high_confidence')
),
updated_at = CURRENT_TIMESTAMP
WHERE iccid IN (
    SELECT iccid FROM fake_to_real_mapping
    WHERE match_method IN ('usb_port_match', 'temporal_high_confidence')
);

SELECT 'Updated ' || changes() || ' SIMs with high confidence mappings' as status;

-- Update archive with correction info
UPDATE sims_archive_fake_relationships
SET
    corrected_modem_id = (
        SELECT real_modem_id FROM fake_to_real_mapping
        WHERE fake_to_real_mapping.iccid = sims_archive_fake_relationships.iccid
    ),
    correction_method = (
        SELECT match_method FROM fake_to_real_mapping
        WHERE fake_to_real_mapping.iccid = sims_archive_fake_relationships.iccid
    )
WHERE iccid IN (SELECT iccid FROM fake_to_real_mapping);

-- ============================================================================
-- STEP 6: Handle SIMs Without Good Mapping (Conservative Approach)
-- ============================================================================

-- For SIMs we couldn't confidently map, set current_modem_id to NULL
-- This is safer than guessing - they'll be re-associated on next daemon sync
UPDATE sims
SET current_modem_id = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE current_modem_id LIKE 'MODEM_%';

SELECT 'Set ' || changes() || ' SIMs to NULL (no confident mapping found)' as status;

-- Update archive
UPDATE sims_archive_fake_relationships
SET
    corrected_modem_id = NULL,
    correction_method = 'set_to_null_no_mapping'
WHERE correction_method = 'pending';

-- ============================================================================
-- STEP 7: Clean Up modem_state Table
-- ============================================================================

-- Archive modem_state entries for fake modems
INSERT INTO modem_sim_history_archive_fake
SELECT
    NULL as id, -- history table ID not preserved
    modem_id,
    NULL as sim_iccid,
    NULL as inserted_at,
    NULL as removed_at,
    signal_quality,
    network_type,
    access_tech,
    CURRENT_TIMESTAMP as archived_at
FROM modem_state
WHERE modem_id LIKE 'MODEM_%';

-- Delete fake modem_state entries
DELETE FROM modem_state
WHERE modem_id LIKE 'MODEM_%';

SELECT 'Deleted ' || changes() || ' fake modem_state entries' as status;

-- ============================================================================
-- STEP 8: Archive and Update modem_sim_history
-- ============================================================================

-- Archive history entries with fake modems
INSERT INTO modem_sim_history_archive_fake
SELECT
    *,
    CURRENT_TIMESTAMP as archived_at
FROM modem_sim_history
WHERE modem_id LIKE 'MODEM_%';

SELECT 'Archived ' || changes() || ' modem_sim_history entries with fake modems' as status;

-- Mark fake history entries with note (keep for audit trail)
UPDATE modem_sim_history
SET removed_at = COALESCE(removed_at, CURRENT_TIMESTAMP)
WHERE modem_id LIKE 'MODEM_%'
  AND removed_at IS NULL;

SELECT 'Closed ' || changes() || ' open fake modem_sim_history entries' as status;

-- ============================================================================
-- STEP 9: Delete Fake Modem Entries (Final Step)
-- ============================================================================

DELETE FROM modems
WHERE equipment_id LIKE 'MODEM_%';

SELECT 'DELETED ' || changes() || ' fake modem records' as status;

-- ============================================================================
-- STEP 10: Verification Queries
-- ============================================================================

SELECT '=== CLEANUP VERIFICATION ===' as section;

-- Should be 0
SELECT
    'Remaining fake modems: ' || COUNT(*) as verification_1
FROM modems
WHERE equipment_id LIKE 'MODEM_%';

-- Should be 0
SELECT
    'SIMs pointing to fake modems: ' || COUNT(*) as verification_2
FROM sims
WHERE current_modem_id LIKE 'MODEM_%';

-- Should be 0
SELECT
    'modem_state with fake IDs: ' || COUNT(*) as verification_3
FROM modem_state
WHERE modem_id LIKE 'MODEM_%';

-- Count archived records
SELECT
    'Archived fake modems: ' || COUNT(*) as verification_4
FROM modems_archive_fake;

SELECT
    'Archived SIM relationships: ' || COUNT(*) as verification_5
FROM sims_archive_fake_relationships;

-- Show correction methods distribution
SELECT
    correction_method,
    COUNT(*) as count
FROM sims_archive_fake_relationships
GROUP BY correction_method
ORDER BY count DESC;

-- Show orphaned SIMs (should investigate these)
SELECT
    'Orphaned SIMs (pointing to non-existent modems): ' || COUNT(*) as verification_6
FROM sims
WHERE current_modem_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM modems WHERE equipment_id = sims.current_modem_id
  );

-- ============================================================================
-- STEP 11: Cleanup Temporary Tables
-- ============================================================================

DROP TABLE IF EXISTS fake_to_real_mapping;

SELECT 'Cleanup complete - temporary tables dropped' as final_status;

-- ============================================================================
-- END OF CLEANUP
-- ============================================================================

SELECT '=== CLEANUP COMPLETE ===' as section;
SELECT 'Review verification results above' as instruction;
SELECT 'Check archived tables for audit trail: modems_archive_fake, sims_archive_fake_relationships' as instruction;
