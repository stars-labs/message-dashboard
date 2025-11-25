-- Analysis Script: Identify Fake MODEM_ Entries and Their Impact
-- Purpose: Understand the scope of corruption before cleanup
-- Usage: npx wrangler d1 execute sms-dashboard --remote --file=sql/analyze-fake-modems.sql

-- ============================================================================
-- SECTION 1: Identify All Fake Modem Entries
-- ============================================================================

SELECT '=== FAKE MODEM ENTRIES ===' as section;

SELECT
    equipment_id,
    manufacturer,
    model,
    firmware_revision,
    status,
    updated_at,
    created_at,
    ROUND((julianday('now') - julianday(updated_at)) * 24, 1) as hours_since_update
FROM modems
WHERE equipment_id LIKE 'MODEM_%'
ORDER BY updated_at DESC;

-- ============================================================================
-- SECTION 2: Count Affected SIMs
-- ============================================================================

SELECT '=== AFFECTED SIMS ===' as section;

SELECT
    COUNT(*) as total_sims_with_fake_modems,
    COUNT(DISTINCT current_modem_id) as unique_fake_modem_ids
FROM sims
WHERE current_modem_id LIKE 'MODEM_%';

-- ============================================================================
-- SECTION 3: Detailed SIM Mappings
-- ============================================================================

SELECT '=== SIM TO FAKE MODEM MAPPINGS ===' as section;

SELECT
    s.iccid,
    s.phone_number,
    s.current_modem_id as fake_modem_id,
    s.operator_name,
    s.status as sim_status,
    s.updated_at as sim_last_update,
    m.status as modem_status,
    m.updated_at as modem_last_update,
    ROUND((julianday('now') - julianday(s.updated_at)) * 24, 1) as hours_since_sim_update
FROM sims s
LEFT JOIN modems m ON s.current_modem_id = m.equipment_id
WHERE s.current_modem_id LIKE 'MODEM_%'
ORDER BY s.updated_at DESC;

-- ============================================================================
-- SECTION 4: Find Potential Real Modems (Temporal Correlation)
-- ============================================================================

SELECT '=== POTENTIAL REAL MODEM MATCHES ===' as section;

-- For each SIM with fake modem, find real modems active around same time
SELECT
    s.iccid,
    s.phone_number,
    s.current_modem_id as fake_modem,
    m.equipment_id as potential_real_modem,
    m.manufacturer,
    m.model,
    ms.usb_port,
    ms.signal_percent,
    ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) as time_diff_seconds,
    CASE
        WHEN ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) < 60 THEN 'HIGH'
        WHEN ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) < 300 THEN 'MEDIUM'
        ELSE 'LOW'
    END as confidence
FROM sims s
CROSS JOIN modems m
LEFT JOIN modem_state ms ON m.equipment_id = ms.modem_id
WHERE s.current_modem_id LIKE 'MODEM_%'
  AND m.equipment_id NOT LIKE 'MODEM_%'
  AND m.equipment_id NOT LIKE 'SIM_%'
  AND m.status = 'connected'
  -- Within 10 minute window
  AND ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) < 600
ORDER BY s.iccid, time_diff_seconds ASC;

-- ============================================================================
-- SECTION 5: Check modem_state Table
-- ============================================================================

SELECT '=== MODEM_STATE WITH FAKE IDS ===' as section;

SELECT
    ms.modem_id,
    ms.modem_index,
    ms.usb_port,
    ms.signal_percent,
    ms.rssi,
    ms.connection_status,
    ms.updated_at,
    m.manufacturer,
    m.model
FROM modem_state ms
LEFT JOIN modems m ON ms.modem_id = m.equipment_id
WHERE ms.modem_id LIKE 'MODEM_%'
ORDER BY ms.updated_at DESC;

-- ============================================================================
-- SECTION 6: Check modem_sim_history for Corruption
-- ============================================================================

SELECT '=== MODEM_SIM_HISTORY WITH FAKE IDS ===' as section;

SELECT
    msh.modem_id,
    msh.sim_iccid,
    msh.inserted_at,
    msh.removed_at,
    CASE
        WHEN msh.removed_at IS NULL THEN 'CURRENT'
        ELSE 'HISTORICAL'
    END as status,
    ROUND((julianday(COALESCE(msh.removed_at, 'now')) - julianday(msh.inserted_at)) * 24, 1) as duration_hours
FROM modem_sim_history msh
WHERE msh.modem_id LIKE 'MODEM_%'
ORDER BY msh.inserted_at DESC
LIMIT 50;

-- ============================================================================
-- SECTION 7: Summary Statistics
-- ============================================================================

SELECT '=== SUMMARY STATISTICS ===' as section;

SELECT
    (SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%') as fake_modems_count,
    (SELECT COUNT(*) FROM modems WHERE equipment_id NOT LIKE 'MODEM_%' AND equipment_id NOT LIKE 'SIM_%') as real_modems_count,
    (SELECT COUNT(*) FROM sims WHERE current_modem_id LIKE 'MODEM_%') as sims_with_fake_modems,
    (SELECT COUNT(*) FROM sims WHERE current_modem_id NOT LIKE 'MODEM_%' AND current_modem_id NOT LIKE 'SIM_%') as sims_with_real_modems,
    (SELECT COUNT(*) FROM sims WHERE current_modem_id IS NULL) as sims_without_modem,
    (SELECT COUNT(*) FROM modem_sim_history WHERE modem_id LIKE 'MODEM_%') as fake_history_entries,
    ROUND((SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%') * 100.0 / (SELECT COUNT(*) FROM modems), 2) as fake_percentage;

-- ============================================================================
-- SECTION 8: Recent Fake Modem Activity Pattern
-- ============================================================================

SELECT '=== FAKE MODEM CREATION TIMELINE ===' as section;

-- Group fake modems by creation date to understand when corruption occurred
SELECT
    date(created_at) as creation_date,
    COUNT(*) as fake_modems_created,
    GROUP_CONCAT(equipment_id, ', ') as fake_ids
FROM modems
WHERE equipment_id LIKE 'MODEM_%'
GROUP BY date(created_at)
ORDER BY creation_date DESC;

-- ============================================================================
-- SECTION 9: USB Port Analysis
-- ============================================================================

SELECT '=== USB PORT OCCUPANCY ===' as section;

-- See which USB ports have fake vs real modems
SELECT
    ms.usb_port,
    COUNT(*) as total_modems,
    SUM(CASE WHEN m.equipment_id LIKE 'MODEM_%' THEN 1 ELSE 0 END) as fake_modems,
    SUM(CASE WHEN m.equipment_id NOT LIKE 'MODEM_%' AND m.equipment_id NOT LIKE 'SIM_%' THEN 1 ELSE 0 END) as real_modems,
    GROUP_CONCAT(DISTINCT m.equipment_id) as modem_ids
FROM modem_state ms
INNER JOIN modems m ON ms.modem_id = m.equipment_id
WHERE ms.usb_port IS NOT NULL
GROUP BY ms.usb_port
ORDER BY ms.usb_port;

-- ============================================================================
-- SECTION 10: Orphaned Relationships
-- ============================================================================

SELECT '=== ORPHANED SIMS (pointing to non-existent modems) ===' as section;

SELECT
    s.iccid,
    s.phone_number,
    s.current_modem_id,
    s.status,
    s.updated_at
FROM sims s
WHERE s.current_modem_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM modems m WHERE m.equipment_id = s.current_modem_id
  )
ORDER BY s.updated_at DESC;

-- ============================================================================
-- END OF ANALYSIS
-- ============================================================================

SELECT '=== ANALYSIS COMPLETE ===' as section;
