-- Migration 019: Fix device_view and device_stats status matching
--
-- The Rust daemon writes these status values:
--   modems.status        = 'active' | 'disconnected'
--   sims.status          = 'active' | 'inactive'
--   modem_state.connection_status = 'active'
--
-- Both views were checking connection_status = 'registered' which never
-- matched, so no device ever got status 'online'. They all fell through
-- to 'registered' in device_view, and online_devices was always 0 in
-- device_stats.

-- Fix device_view: connection_status 'active' → 'online'
DROP VIEW IF EXISTS device_view;

CREATE VIEW device_view AS
SELECT
  COALESCE(s.iccid, 'NO_SIM_' || m.equipment_id) as id,

  s.iccid,
  CASE
    WHEN s.user_override_enabled = TRUE AND s.user_phone_number IS NOT NULL
    THEN s.user_phone_number
    ELSE s.phone_number
  END as number,
  CASE
    WHEN s.user_override_enabled = TRUE AND s.user_country_code IS NOT NULL
    THEN s.user_country_code
    ELSE s.country_code
  END as country,
  CASE
    WHEN s.country_code = 'CN' OR (s.user_override_enabled = TRUE AND s.user_country_code = 'CN') THEN '🇨🇳'
    WHEN s.country_code = 'US' OR (s.user_override_enabled = TRUE AND s.user_country_code = 'US') THEN '🇺🇸'
    WHEN s.country_code = 'SG' OR (s.user_override_enabled = TRUE AND s.user_country_code = 'SG') THEN '🇸🇬'
    WHEN s.country_code = 'HK' OR (s.user_override_enabled = TRUE AND s.user_country_code = 'HK') THEN '🇭🇰'
    ELSE '🌍'
  END as flag,
  CASE
    WHEN s.user_override_enabled = TRUE AND s.user_carrier IS NOT NULL
    THEN s.user_carrier
    ELSE s.carrier
  END as carrier,
  s.operator_name,
  s.operator_id,

  -- Status: daemon writes 'active' for all three fields when device is healthy
  CASE
    WHEN m.status IN ('connected', 'active') AND s.status = 'active' AND ms.connection_status IN ('registered', 'active') THEN 'online'
    WHEN m.status IN ('connected', 'active') AND s.status = 'active' THEN 'registered'
    WHEN m.status IN ('connected', 'active') AND s.iccid IS NULL THEN 'sim-missing'
    WHEN m.status = 'disconnected' THEN 'offline'
    ELSE 'error'
  END as status,

  ms.signal_percent as signal,
  ms.rssi,
  ms.rsrq,
  ms.rsrp,
  ms.snr,
  ms.network_type,
  ms.access_tech,

  m.equipment_id as imei,
  m.equipment_id as modem_id,
  m.manufacturer as modem_manufacturer,
  m.model as modem_model,
  m.firmware_revision,
  ms.usb_port,
  ms.modem_index,
  m.status as modem_status,
  m.error_count as modem_error_count,
  m.last_error as modem_last_error,

  s.iccid as sim_iccid,
  CASE
    WHEN s.user_override_enabled = TRUE AND s.user_phone_number IS NOT NULL
    THEN s.user_phone_number
    ELSE s.phone_number
  END as sim_phone_number,
  s.status as sim_status,
  s.activation_date as sim_activation_date,
  s.sim_index,

  s.user_phone_number,
  s.user_carrier,
  s.user_country_code,
  s.user_notes,
  s.user_override_enabled,
  s.user_updated_at,
  s.user_updated_by,

  m.updated_at as modem_updated_at,
  s.updated_at as sim_updated_at,
  ms.updated_at as state_updated_at,
  CASE
    WHEN m.updated_at >= s.updated_at AND m.updated_at >= ms.updated_at THEN m.updated_at
    WHEN s.updated_at >= ms.updated_at THEN s.updated_at
    ELSE ms.updated_at
  END as updated_at
FROM modems m
LEFT JOIN sims s ON s.current_modem_id = m.equipment_id
LEFT JOIN modem_state ms ON ms.modem_id = m.equipment_id
ORDER BY
  CASE WHEN ms.usb_port IS NOT NULL THEN CAST(ms.usb_port AS INTEGER) ELSE 999 END,
  s.iccid;

-- Fix device_stats: same connection_status mismatch + modem status mismatch
DROP VIEW IF EXISTS device_stats;

CREATE VIEW device_stats AS
SELECT
  COUNT(DISTINCT m.equipment_id) as total_modems,
  COUNT(DISTINCT CASE WHEN m.status IN ('connected', 'active') THEN m.equipment_id END) as connected_modems,
  COUNT(DISTINCT s.iccid) as total_sims,
  COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.iccid END) as active_sims,
  COUNT(DISTINCT CASE
    WHEN m.status IN ('connected', 'active') AND s.status = 'active' AND ms.connection_status IN ('registered', 'active')
    THEN m.equipment_id
  END) as online_devices,
  AVG(CASE WHEN ms.signal_percent IS NOT NULL THEN ms.signal_percent END) as avg_signal_strength
FROM modems m
LEFT JOIN sims s ON s.current_modem_id = m.equipment_id
LEFT JOIN modem_state ms ON ms.modem_id = m.equipment_id;
