-- Rollback Script: Restore phones table from modems/sims
-- WARNING: Only run this if migration failed and you need to restore the old schema

-- 1. Recreate phones table if it doesn't exist
CREATE TABLE IF NOT EXISTS phones (
    id TEXT PRIMARY KEY,           -- ICCID
    number TEXT,
    status TEXT DEFAULT 'offline',
    signal INTEGER,
    rssi INTEGER,
    rsrq INTEGER,
    rsrp INTEGER,
    snr INTEGER,
    carrier TEXT,
    operator_name TEXT,
    operator_id TEXT,
    country TEXT,
    network_type TEXT,
    access_tech TEXT,
    imei TEXT,
    modem_index INTEGER,
    sim_index INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Copy data back from device_view
INSERT OR REPLACE INTO phones (
    id,
    number,
    status,
    signal,
    rssi,
    rsrq,
    rsrp,
    snr,
    carrier,
    operator_name,
    operator_id,
    country,
    network_type,
    access_tech,
    imei,
    modem_index,
    sim_index,
    created_at,
    updated_at
)
SELECT 
    iccid as id,
    phone_number as number,
    CASE 
        WHEN modem_status = 'connected' AND sim_status = 'active' THEN 'online'
        WHEN modem_status = 'connected' THEN 'active'
        ELSE 'offline'
    END as status,
    signal_percent as signal,
    rssi,
    rsrq,
    rsrp,
    snr,
    carrier,
    operator_name,
    operator_id,
    country_code as country,
    network_type,
    access_tech,
    equipment_id as imei,
    modem_index,
    sim_index,
    COALESCE(sim_created_at, modem_created_at) as created_at,
    COALESCE(sim_updated_at, modem_updated_at) as updated_at
FROM device_view
WHERE iccid IS NOT NULL;

-- 3. Verify rollback
SELECT 'Rollback Summary:' as status;
SELECT 
    (SELECT COUNT(*) FROM phones) as restored_phones,
    (SELECT COUNT(*) FROM phones WHERE status = 'online') as online_phones,
    (SELECT COUNT(*) FROM phones WHERE status = 'offline') as offline_phones;

-- 4. Optional: Drop new tables (uncomment if you want to fully revert)
-- DROP TABLE IF EXISTS modem_sim_history;
-- DROP TABLE IF EXISTS modem_state;
-- DROP TABLE IF EXISTS sims;
-- DROP TABLE IF EXISTS modems;
-- DROP VIEW IF EXISTS device_view;