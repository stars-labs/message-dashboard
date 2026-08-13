-- Migration 038: preserve a modem's last known physical USB location
--
-- usb_path remains volatile current state: NULL means the modem is not currently
-- enumerated. last_usb_path is durable history and is updated only when the daemon
-- reports a real sysfs topology path.

ALTER TABLE modems ADD COLUMN last_usb_path TEXT;

-- Seed history for every modem that is online when this migration is applied.
UPDATE modems
SET last_usb_path = usb_path
WHERE usb_path IS NOT NULL;

-- The 2026-08-13 physical inventory found three unavailable modules. They cannot
-- report their own path while offline, so seed the audited empty/residual slots by
-- immutable IMEI. These become ordinary history and will be replaced automatically
-- the next time each modem enumerates at a real path.
UPDATE modems SET last_usb_path = '1-1.3.3.3.4' WHERE equipment_id = '865827078904976'; -- S31
UPDATE modems SET last_usb_path = '1-1.3.1.5.3' WHERE equipment_id = '865827078940863'; -- S62
UPDATE modems SET last_usb_path = '5-1.3.5.4'   WHERE equipment_id = '865827078973062'; -- S91

DROP VIEW IF EXISTS device_view;
CREATE VIEW device_view AS
SELECT
  s.iccid as id,
  m.equipment_id,
  m.manufacturer,
  m.model,
  m.usb_port as primary_port,
  m.usb_path,
  m.last_usb_path,
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
