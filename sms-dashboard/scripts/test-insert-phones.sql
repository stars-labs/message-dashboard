-- Insert test phones with the real ICCIDs
INSERT INTO phones (iccid, number, carrier, status, signal, operator_name, access_tech, updated_at)
VALUES 
    ('89860040191833946266', '+8615000000001', 'CMCC', 'online', 100, 'China Mobile', 'LTE', CURRENT_TIMESTAMP),
    ('89860122802142937419', '+8613000000001', 'China Unicom', 'online', 100, 'China Unicom', 'LTE', CURRENT_TIMESTAMP),
    ('8965030124051507919', '+6590000001', 'M1', 'online', 100, 'M1', 'LTE', CURRENT_TIMESTAMP),
    ('89852122109190418053', '+85290000001', 'CMHK', 'searching', 100, 'CMHK', 'LTE', CURRENT_TIMESTAMP),
    ('8965030124051507851', '+6590000002', 'M1', 'online', 100, 'M1', 'LTE', CURRENT_TIMESTAMP)
ON CONFLICT(iccid) DO UPDATE SET
    number = excluded.number,
    carrier = excluded.carrier,
    status = excluded.status,
    signal = excluded.signal,
    operator_name = excluded.operator_name,
    access_tech = excluded.access_tech,
    updated_at = CURRENT_TIMESTAMP;