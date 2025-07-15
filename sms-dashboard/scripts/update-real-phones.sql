-- Update database with real ICCIDs from Orange Pi

-- First, clean up any existing test data
DELETE FROM phones WHERE iccid LIKE 'SIM_%' OR iccid IN ('123456789', '987654321');

-- Insert/update real phones with ICCIDs from the Orange Pi
INSERT INTO phones (iccid, number, country, flag, carrier, operator_name, operator_id, status, signal)
VALUES 
    ('89860040191833946266', NULL, 'CN', '🇨🇳', NULL, 'CMCC', '46002', 'online', 100),
    ('89860122802142937419', NULL, 'CN', '🇨🇳', NULL, 'China Unicom', '46001', 'online', 100),
    ('8965030124051507919', NULL, 'SG', '🇸🇬', NULL, 'M1', '52503', 'online', 100),
    ('89852122109190418053', NULL, 'HK', '🇭🇰', NULL, 'CMHK', '45412', 'online', 100),
    ('8965030124051507851', NULL, 'SG', '🇸🇬', NULL, 'M1', '52503', 'online', 100)
ON CONFLICT(iccid) DO UPDATE SET
    operator_name = excluded.operator_name,
    operator_id = excluded.operator_id,
    country = excluded.country,
    flag = excluded.flag,
    status = excluded.status,
    updated_at = CURRENT_TIMESTAMP;