-- Add phone number mappings for your real ICCIDs
-- You can update these with the actual phone numbers

INSERT INTO iccid_mappings (id, iccid, phone_number, carrier, country, notes, is_active, created_at, updated_at)
VALUES 
    (lower(hex(randomblob(16))), '89860040191833946266', '+8615000000001', 'CMCC', 'CN', 'China Mobile SIM 1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (lower(hex(randomblob(16))), '89860122802142937419', '+8613000000001', 'China Unicom', 'CN', 'China Unicom SIM', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (lower(hex(randomblob(16))), '8965030124051507919', '+6590000001', 'M1', 'SG', 'Singapore M1 SIM 1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (lower(hex(randomblob(16))), '89852122109190418053', '+85290000001', 'CMHK', 'HK', 'Hong Kong CMHK SIM', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (lower(hex(randomblob(16))), '8965030124051507851', '+6590000002', 'M1', 'SG', 'Singapore M1 SIM 2', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(iccid) DO UPDATE SET
    phone_number = excluded.phone_number,
    carrier = excluded.carrier,
    country = excluded.country,
    notes = excluded.notes,
    is_active = excluded.is_active,
    updated_at = CURRENT_TIMESTAMP;

-- Update the phones table with these numbers
UPDATE phones SET number = '+8615000000001' WHERE iccid = '89860040191833946266';
UPDATE phones SET number = '+8613000000001' WHERE iccid = '89860122802142937419';
UPDATE phones SET number = '+6590000001' WHERE iccid = '8965030124051507919';
UPDATE phones SET number = '+85290000001' WHERE iccid = '89852122109190418053';
UPDATE phones SET number = '+6590000002' WHERE iccid = '8965030124051507851';