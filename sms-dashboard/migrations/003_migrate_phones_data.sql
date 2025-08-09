-- Migration 003: Migrate existing data from phones table to new schema
-- Run this after 002_refactor_phones_to_modems_sims.sql

-- Step 1: Migrate modems data
-- Extract unique modems from phones table
INSERT OR IGNORE INTO modems (
    equipment_id, 
    status,
    first_seen,
    last_seen
)
SELECT DISTINCT
    CASE 
        WHEN iccid LIKE 'NO_SIM_MODEM_%' THEN 
            'SYNTHETIC_' || REPLACE(iccid, 'NO_SIM_MODEM_', '')
        WHEN imei IS NOT NULL AND imei != '' THEN 
            imei
        ELSE 
            'UNKNOWN_' || ABS(RANDOM() % 1000000)
    END as equipment_id,
    CASE 
        WHEN status IN ('online', 'active', 'registered', 'sim-missing') THEN 'connected'
        ELSE 'disconnected'
    END as status,
    COALESCE(created_at, updated_at, CURRENT_TIMESTAMP) as first_seen,
    COALESCE(updated_at, CURRENT_TIMESTAMP) as last_seen
FROM phones
WHERE iccid LIKE 'NO_SIM_MODEM_%'
   OR (imei IS NOT NULL AND imei != '');

-- Step 2: Migrate SIMs data
-- Extract real SIM cards (not synthetic entries)
INSERT OR IGNORE INTO sims (
    iccid,
    phone_number,
    country_code,
    carrier,
    operator_name,
    operator_id,
    current_modem_id,
    status,
    activation_date
)
SELECT 
    p.iccid,
    p.number as phone_number,
    CASE 
        WHEN p.country = '中国' OR p.flag = '🇨🇳' THEN 'CN'
        WHEN p.country = '香港' OR p.flag = '🇭🇰' THEN 'HK'
        WHEN p.country = '新加坡' OR p.flag = '🇸🇬' THEN 'SG'
        WHEN p.country = 'United States' OR p.flag = '🇺🇸' THEN 'US'
        ELSE SUBSTR(p.country, 1, 2)
    END as country_code,
    p.carrier,
    p.operator_name,
    p.operator_id,
    p.imei as current_modem_id,
    CASE 
        WHEN p.status IN ('online', 'active', 'registered') THEN 'active'
        ELSE 'inactive'
    END as status,
    COALESCE(p.created_at, p.updated_at, CURRENT_TIMESTAMP) as activation_date
FROM phones p
WHERE p.iccid IS NOT NULL 
  AND p.iccid != ''
  AND p.iccid NOT LIKE 'phone-%'
  AND p.iccid NOT LIKE 'NO_SIM_%'
  AND p.iccid NOT LIKE 'UNKNOWN_%';

-- Step 3: Migrate modem state for currently online devices
INSERT OR IGNORE INTO modem_state (
    modem_id,
    signal_percent,
    rssi,
    rsrq,
    rsrp,
    snr,
    access_tech,
    connection_status
)
SELECT 
    imei as modem_id,
    signal as signal_percent,
    rssi,
    rsrq,
    rsrp,
    snr,
    access_tech,
    CASE 
        WHEN status IN ('online', 'active', 'registered') THEN 'registered'
        WHEN status = 'searching' THEN 'searching'
        ELSE 'denied'
    END as connection_status
FROM phones p
WHERE imei IS NOT NULL AND imei != ''
  AND status IN ('online', 'active', 'registered')
  AND (signal IS NOT NULL OR rssi IS NOT NULL);

-- Step 4: Create initial modem-SIM associations for current state
INSERT OR IGNORE INTO modem_sim_history (
    modem_id,
    sim_iccid,
    inserted_at,
    signal_quality,
    access_tech
)
SELECT 
    s.current_modem_id,
    s.iccid,
    s.activation_date,
    ms.signal_percent,
    ms.access_tech
FROM sims s
INNER JOIN modem_state ms ON s.current_modem_id = ms.modem_id
WHERE s.current_modem_id IS NOT NULL;

-- Step 5: Update messages table to use new foreign keys
-- First, add the new columns if they don't exist
ALTER TABLE messages ADD COLUMN sim_iccid TEXT;
ALTER TABLE messages ADD COLUMN modem_id TEXT;

-- Populate the new columns from existing data
UPDATE messages
SET sim_iccid = phone_iccid
WHERE phone_iccid IS NOT NULL 
  AND phone_iccid != ''
  AND phone_iccid NOT LIKE 'NO_SIM_%';

UPDATE messages
SET modem_id = (
    SELECT current_modem_id 
    FROM sims 
    WHERE sims.iccid = messages.sim_iccid
)
WHERE sim_iccid IS NOT NULL;

-- Step 6: Log migration completion
INSERT INTO schema_version (version, description) 
VALUES (3, 'Migrate existing phones data to modems and sims tables');

-- Step 7: Verify migration success
SELECT 'Migration Summary:' as info;
SELECT 'Original phones count: ' || COUNT(*) as stat FROM phones;
SELECT 'Migrated modems: ' || COUNT(*) as stat FROM modems;
SELECT 'Migrated SIMs: ' || COUNT(*) as stat FROM sims;
SELECT 'Modem states: ' || COUNT(*) as stat FROM modem_state;
SELECT 'SIM associations: ' || COUNT(*) as stat FROM modem_sim_history;

-- Step 8: List any phones that couldn't be migrated
SELECT 'Unmigrated phones (require manual review):' as warning;
SELECT iccid, number, status, imei
FROM phones
WHERE iccid NOT IN (
    SELECT iccid FROM sims
    UNION
    SELECT 'NO_SIM_MODEM_' || REPLACE(equipment_id, 'SYNTHETIC_', '') FROM modems WHERE equipment_id LIKE 'SYNTHETIC_%'
)
LIMIT 10;