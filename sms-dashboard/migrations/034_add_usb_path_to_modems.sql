-- Migration 034: add stable USB topology path to modems + expose via device_view
-- The USB path (e.g. "1-1.4.2.2.2") encodes the physical socket and is stable across
-- reboot/replug/daemon-restart, unlike modem_index/ttyUSB. Daemon populates it; NULL
-- means the modem is not currently enumerated on a working USB socket.

ALTER TABLE modems ADD COLUMN usb_path TEXT;

DROP VIEW IF EXISTS device_view;
CREATE VIEW device_view AS
SELECT
  s.iccid as id,
  m.equipment_id,
  m.manufacturer,
  m.model,
  m.usb_port as primary_port,
  m.usb_path,
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
