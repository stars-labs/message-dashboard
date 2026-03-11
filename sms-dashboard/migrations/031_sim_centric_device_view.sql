-- Rebuild device_view to be SIM-centric (show all SIMs, not all modems)
-- This makes Phone Number List count match dashboard stats (95 SIMs)

DROP VIEW IF EXISTS device_view;

CREATE VIEW device_view AS
SELECT
  -- Use SIM's ICCID as primary ID (stable identifier)
  s.iccid as id,

  -- Modem hardware details (NULL if SIM not currently in a modem)
  m.equipment_id,
  m.manufacturer,
  m.model,
  m.usb_port as primary_port,
  m.status as modem_status,

  -- SIM inventory data (always present)
  s.iccid,
  s.phone_number as number,
  s.carrier,
  s.country_code as country,
  s.sim_index,
  s.notes,

  -- Network operator (from modem if active)
  m.operator,

  -- Computed status: active if this SIM is in any modem right now
  CASE
    WHEN m.current_iccid IS NOT NULL THEN 'active'
    ELSE 'inactive'
  END as sim_status,

  -- Signal/connection data (NULL if not active)
  ms.signal_percent as signal_quality,
  ms.connection_status,
  ms.network_type,

  -- Timestamps
  m.created_at,
  s.updated_at

FROM sims s
LEFT JOIN modems m ON s.iccid = m.current_iccid
LEFT JOIN modem_state ms ON ms.modem_id = m.equipment_id

ORDER BY s.sim_index ASC;
