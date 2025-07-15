-- Step 3: Restore data from backup tables

-- Restore phones data using ICCID as primary key
INSERT INTO phones (iccid, number, country, flag, carrier, status, signal, rssi, rsrq, rsrp, snr, operator_name, operator_id, imei, access_tech, created_at, updated_at)
SELECT 
    COALESCE(iccid, id) as iccid,  -- Use ICCID if available, otherwise use ID
    number,
    country,
    flag,
    carrier,
    status,
    signal,
    rssi,
    rsrq,
    rsrp,
    snr,
    operator_name,
    operator_id,
    imei,
    access_tech,
    created_at,
    updated_at
FROM phones_backup
WHERE (iccid IS NOT NULL AND iccid != '') OR (id IS NOT NULL AND id != '');

-- Restore messages data
INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, recipient, status, verification_code)
SELECT 
    m.id,
    COALESCE(p.iccid, m.phone_id) as phone_iccid,
    m.phone_number,
    m.content,
    m.timestamp,
    m.type,
    m.recipient,
    m.status,
    m.verification_code
FROM messages_backup m
LEFT JOIN phones_backup p ON m.phone_id = p.id
WHERE COALESCE(p.iccid, m.phone_id) IN (SELECT iccid FROM phones);

-- Drop backup tables
DROP TABLE phones_backup;
DROP TABLE messages_backup;