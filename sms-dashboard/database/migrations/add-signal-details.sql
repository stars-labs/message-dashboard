-- Add ICCID and detailed signal information columns to phones table
ALTER TABLE phones ADD COLUMN iccid TEXT;
ALTER TABLE phones ADD COLUMN rssi REAL;
ALTER TABLE phones ADD COLUMN rsrq REAL;
ALTER TABLE phones ADD COLUMN rsrp REAL;
ALTER TABLE phones ADD COLUMN snr REAL;

-- Create index for ICCID lookups
CREATE INDEX IF NOT EXISTS idx_phones_iccid ON phones(iccid);

-- Update some sample data with signal details
UPDATE phones SET 
  rssi = -44.0,
  rsrq = -6.0,
  rsrp = -70.0,
  snr = 28.0
WHERE id = 'SIM_001' AND status = 'online';

UPDATE phones SET 
  rssi = -52.0,
  rsrq = -8.0,
  rsrp = -78.0,
  snr = 24.0
WHERE id = 'SIM_002' AND status = 'online';

UPDATE phones SET 
  rssi = -65.0,
  rsrq = -11.0,
  rsrp = -85.0,
  snr = 18.0
WHERE id = 'SIM_003' AND status = 'online';