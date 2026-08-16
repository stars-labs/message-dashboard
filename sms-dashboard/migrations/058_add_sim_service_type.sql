-- Migration 058: add user-verified SIM billing type metadata
--
-- Payment type belongs to the user-owned SIM inventory. It is not modem state
-- and must never be inferred from the detected operator or a balance reply.

ALTER TABLE sims ADD COLUMN service_type TEXT NOT NULL DEFAULT 'unknown'
  CHECK(service_type IN ('unknown', 'prepaid', 'postpaid'));

ALTER TABLE sims ADD COLUMN service_type_source TEXT
  CHECK(service_type_source IS NULL OR service_type_source IN (
    'carrier_account', 'carrier_support', 'contract_or_bill', 'carrier_message'
  ));

ALTER TABLE sims ADD COLUMN service_type_verified_at TIMESTAMP;

-- Keep direct SQL and future import paths inside the same trust boundary as the
-- HTTP API: a known type is valid only with evidence metadata, while unknown
-- carries no stale evidence.
CREATE TRIGGER validate_sim_service_type_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.service_type = 'unknown'
    AND NEW.service_type_source IS NULL
    AND NEW.service_type_verified_at IS NULL)
  OR
  (NEW.service_type IN ('prepaid', 'postpaid')
    AND NEW.service_type_source IS NOT NULL
    AND NEW.service_type_verified_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid SIM service type verification metadata');
END;

CREATE TRIGGER validate_sim_service_type_update
BEFORE UPDATE OF service_type, service_type_source, service_type_verified_at ON sims
WHEN NOT (
  (NEW.service_type = 'unknown'
    AND NEW.service_type_source IS NULL
    AND NEW.service_type_verified_at IS NULL)
  OR
  (NEW.service_type IN ('prepaid', 'postpaid')
    AND NEW.service_type_source IS NOT NULL
    AND NEW.service_type_verified_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid SIM service type verification metadata');
END;

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
