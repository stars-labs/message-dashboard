-- Migration 032: Add modem health indicators
-- Adds sim_read_status column and dual-join device_view for IMEI fallback

-- 1. Add sim_read_status to modems table
ALTER TABLE modems ADD COLUMN sim_read_status TEXT DEFAULT NULL;
-- Values: 'ok' (ICCID read succeeded), 'failed' (modem alive, ICCID read failed), NULL (legacy)

-- 2. Enforce unique IMEI in sims table to prevent ambiguous fallback join
-- First clear duplicates (keep the one with lowest sim_index)
UPDATE sims SET imei = NULL
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM sims WHERE imei IS NOT NULL GROUP BY imei
) AND imei IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sims_imei_unique ON sims(imei) WHERE imei IS NOT NULL;
DROP INDEX IF EXISTS idx_sims_imei;

-- 3. Recreate device_view with dual join (ICCID primary, sims.imei fallback)
DROP VIEW IF EXISTS device_view;
CREATE VIEW device_view AS
SELECT
  s.iccid as id,
  COALESCE(m_iccid.equipment_id, m_imei.equipment_id) as equipment_id,
  COALESCE(m_iccid.manufacturer, m_imei.manufacturer) as manufacturer,
  COALESCE(m_iccid.model, m_imei.model) as model,
  COALESCE(m_iccid.usb_port, m_imei.usb_port) as primary_port,
  COALESCE(m_iccid.status, m_imei.status) as modem_status,
  s.iccid,
  s.phone_number as number,
  s.carrier,
  s.country_code as country,
  s.sim_index,
  s.notes,
  COALESCE(m_iccid.operator, m_imei.operator) as operator,
  CASE
    WHEN m_iccid.current_iccid IS NOT NULL THEN 'active'
    WHEN m_imei.equipment_id IS NOT NULL THEN 'modem_only'
    ELSE 'inactive'
  END as sim_status,
  COALESCE(m_iccid.sim_read_status, m_imei.sim_read_status) as sim_read_status,
  COALESCE(ms_iccid.signal_percent, ms_imei.signal_percent) as signal_quality,
  COALESCE(ms_iccid.connection_status, ms_imei.connection_status) as connection_status,
  COALESCE(ms_iccid.network_type, ms_imei.network_type) as network_type,
  COALESCE(m_iccid.created_at, m_imei.created_at) as created_at,
  s.updated_at
FROM sims s
LEFT JOIN modems m_iccid ON s.iccid = m_iccid.current_iccid
LEFT JOIN modems m_imei ON s.imei = m_imei.equipment_id
  AND m_iccid.equipment_id IS NULL
LEFT JOIN modem_state ms_iccid ON ms_iccid.modem_id = m_iccid.equipment_id
LEFT JOIN modem_state ms_imei ON ms_imei.modem_id = m_imei.equipment_id
  AND m_iccid.equipment_id IS NULL
ORDER BY s.sim_index ASC;
