-- Migration 033: Clean 2-table schema refactor
-- Merges modem_state into modems, switches to IMEI join, adds 6-state sim_status
-- Drops: modem_state table, dual-join device_view
-- Adds: detected_iccid, detected_operator, signal_percent, rssi to modems

-- 1. Add new columns to modems table
ALTER TABLE modems ADD COLUMN detected_iccid TEXT;
ALTER TABLE modems ADD COLUMN detected_operator TEXT;
ALTER TABLE modems ADD COLUMN signal_percent INTEGER;
ALTER TABLE modems ADD COLUMN rssi INTEGER;

-- 2. Migrate data from existing columns
UPDATE modems SET
  detected_iccid = current_iccid,
  detected_operator = operator;

-- 3. Migrate signal data from modem_state into modems
UPDATE modems SET
  signal_percent = (SELECT ms.signal_percent FROM modem_state ms WHERE ms.modem_id = modems.equipment_id),
  rssi = (SELECT ms.rssi FROM modem_state ms WHERE ms.modem_id = modems.equipment_id);

-- 4. Drop modem_state table (no longer needed)
DROP TABLE IF EXISTS modem_state;

-- 5. Recreate device_view with single IMEI join and 6-state sim_status
DROP VIEW IF EXISTS device_view;
CREATE VIEW device_view AS
SELECT
  s.iccid as id,
  m.equipment_id,
  m.manufacturer,
  m.model,
  m.usb_port as primary_port,
  m.status as modem_status,
  s.iccid,
  s.phone_number as number,
  s.carrier,
  s.country_code as country,
  s.sim_index,
  s.notes,
  m.detected_operator as operator,
  CASE
    WHEN s.imei IS NULL THEN 'unassigned'
    WHEN m.equipment_id IS NULL THEN 'no_modem'
    WHEN m.status = 'disconnected' THEN 'offline'
    WHEN m.detected_iccid IS NULL THEN 'sim_error'
    WHEN m.detected_iccid = s.iccid THEN 'active'
    ELSE 'iccid_mismatch'
  END as sim_status,
  m.signal_percent as signal_quality,
  m.detected_iccid,
  m.detected_phone_number,
  s.imei,
  s.created_at,
  s.updated_at
FROM sims s
LEFT JOIN modems m ON s.imei = m.equipment_id
ORDER BY s.sim_index ASC;
