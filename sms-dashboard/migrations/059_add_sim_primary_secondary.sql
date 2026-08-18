-- Migration 059: SIM primary/secondary relationship
--
-- Some China SIMs are sold as a primary card plus one or more supplementary
-- cards. They are independent physical SIMs (own ICCID, modem slot, phone
-- number) and remain normal rows in `sims` — they still receive SMS and show
-- device status. The ONLY behavioural effect of this relationship is that a
-- secondary SIM must not be selected for balance queries: its balance follows
-- the primary, so querying it is redundant or wrong.
--
-- This is user-owned metadata, exactly like `service_type` (migration 058):
-- the daemon and balance parsers never write or infer it. Validation mirrors
-- 058 — CHECK constraints + BEFORE INSERT/UPDATE triggers for structural
-- invariants; cross-row semantics (the target must be a primary) are enforced
-- in the HTTP handler's resolveSimRole().

-- role of this SIM within a primary/secondary relationship
ALTER TABLE sims ADD COLUMN sim_role TEXT NOT NULL DEFAULT 'standalone'
  CHECK(sim_role IN ('standalone', 'primary', 'secondary'));

-- self-referential: the ICCID of this SIM's primary, only set when sim_role='secondary'.
-- RESTRICT: deleting a primary that still has secondaries is refused — user must
-- detach (set secondaries back to standalone) first. Matches "user-owned metadata".
ALTER TABLE sims ADD COLUMN primary_iccid TEXT
  REFERENCES sims(iccid) ON DELETE RESTRICT;

-- Structural invariant: primary_iccid is set iff sim_role='secondary'.
-- (The target being a real primary is enforced in resolveSimRole(), not here —
-- SQLite triggers cannot check another row without recursion.)
CREATE TRIGGER validate_sim_role_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary'    AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary'  AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;

CREATE TRIGGER validate_sim_role_update
BEFORE UPDATE OF sim_role, primary_iccid ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary'    AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary'  AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;

-- Rebuild device_view to pass the new columns through, so balance queries and
-- the UI never need to read `sims` directly.
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
