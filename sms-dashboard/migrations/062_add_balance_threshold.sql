-- Migration 062: per-SIM balance threshold
--
-- The balance health check flags a SIM as `low` when its cash balance drops
-- below a threshold. That threshold was a hardcoded constant keyed by currency
-- (CNY 100 / SGD 10 / HKD 100). This adds a nullable per-SIM override column
-- so an individual card can tune its own "low balance" alert.
--
-- Empty (NULL) falls back to the currency default — encoded in
-- client/lib/balance-overview.js, not the schema — so existing SIMs keep
-- their current behavior until a value is set.

ALTER TABLE sims ADD COLUMN balance_threshold REAL;

-- Recreate device_view to expose the new column. A pure column add does not
-- require the rebuild dance of migration 060/061; the view just needs to name
-- the new column so query plans surface it.
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
  s.service_type,
  s.service_type_source,
  s.service_type_verified_at,
  s.sim_role,
  s.primary_iccid,
  s.balance_threshold,
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
