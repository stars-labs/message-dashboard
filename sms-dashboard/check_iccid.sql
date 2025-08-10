-- Check the specific ICCID for sim_index
SELECT 
    iccid,
    number,
    modem_index,
    sim_index,
    status,
    datetime(updated_at) as last_update
FROM phones 
WHERE iccid = '898600810118F0075991';

-- Also check if any phones have NULL sim_index
SELECT 
    COUNT(*) as total_phones,
    COUNT(sim_index) as phones_with_sim_index,
    COUNT(*) - COUNT(sim_index) as phones_without_sim_index
FROM phones;

-- List phones without sim_index
SELECT 
    substr(iccid, 1, 15) || '...' as iccid_prefix,
    number,
    modem_index,
    sim_index,
    status
FROM phones 
WHERE sim_index IS NULL
LIMIT 10;