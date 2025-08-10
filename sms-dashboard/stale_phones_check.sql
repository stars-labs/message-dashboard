-- Query to check phones with high modem_index (>=53) or phones that haven't been updated in the last hour
-- Shows ICCID preview, modem_index, status, and time since last update
-- Useful for detecting stale records that claim to be online

SELECT 
    SUBSTR(iccid, 1, 10) || '...' AS iccid_preview,
    modem_index,
    status,
    updated_at,
    CASE 
        WHEN (julianday('now') - julianday(updated_at)) * 24 * 60 < 60 
        THEN ROUND((julianday('now') - julianday(updated_at)) * 24 * 60, 1) || ' minutes ago'
        WHEN (julianday('now') - julianday(updated_at)) * 24 < 24
        THEN ROUND((julianday('now') - julianday(updated_at)) * 24, 1) || ' hours ago'
        ELSE ROUND(julianday('now') - julianday(updated_at), 1) || ' days ago'
    END AS time_since_update,
    ROUND((julianday('now') - julianday(updated_at)) * 24 * 60, 1) AS minutes_since_update
FROM phones 
WHERE 
    modem_index >= 53 
    OR (julianday('now') - julianday(updated_at)) * 24 * 60 > 60
ORDER BY minutes_since_update DESC, modem_index DESC;

-- Query to focus specifically on phones claiming to be online but stale
SELECT 
    SUBSTR(iccid, 1, 10) || '...' AS iccid_preview,
    modem_index,
    status,
    updated_at,
    CASE 
        WHEN (julianday('now') - julianday(updated_at)) * 24 * 60 < 60 
        THEN ROUND((julianday('now') - julianday(updated_at)) * 24 * 60, 1) || ' minutes ago'
        WHEN (julianday('now') - julianday(updated_at)) * 24 < 24
        THEN ROUND((julianday('now') - julianday(updated_at)) * 24, 1) || ' hours ago'
        ELSE ROUND(julianday('now') - julianday(updated_at), 1) || ' days ago'
    END AS time_since_update,
    ROUND((julianday('now') - julianday(updated_at)) * 24 * 60, 1) AS minutes_since_update
FROM phones 
WHERE 
    status IN ('online', 'registered', 'connected') 
    AND (julianday('now') - julianday(updated_at)) * 24 * 60 > 60
ORDER BY minutes_since_update DESC;