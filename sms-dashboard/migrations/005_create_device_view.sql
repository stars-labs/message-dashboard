-- Migration 005: Create device_view for backward compatibility
-- This view combines modems, sims, and modem_state tables to provide a unified interface

-- Drop existing view if it exists
DROP VIEW IF EXISTS device_view;

-- Create comprehensive device view
CREATE VIEW device_view AS
SELECT 
  -- Primary identifier (use SIM iccid if available, otherwise modem id)
  COALESCE(s.iccid, 'NO_SIM_' || m.equipment_id) as id,
  
  -- Legacy fields for backward compatibility
  s.iccid,
  s.phone_number as number,
  s.country_code as country,
  CASE 
    WHEN s.country_code = 'CN' THEN '🇨🇳'
    WHEN s.country_code = 'US' THEN '🇺🇸'
    WHEN s.country_code = 'SG' THEN '🇸🇬'
    WHEN s.country_code = 'HK' THEN '🇭🇰'
    ELSE '🌍'
  END as flag,
  s.carrier,
  s.operator_name,
  s.operator_id,
  
  -- Status calculation
  CASE 
    WHEN m.status = 'connected' AND s.status = 'active' AND ms.connection_status = 'registered' THEN 'online'
    WHEN m.status = 'connected' AND s.status = 'active' THEN 'registered'
    WHEN m.status = 'connected' AND s.iccid IS NULL THEN 'sim-missing'
    WHEN m.status = 'disconnected' THEN 'offline'
    ELSE 'error'
  END as status,
  
  -- Signal data
  ms.signal_percent as signal,
  ms.rssi,
  ms.rsrq,
  ms.rsrp,
  ms.snr,
  ms.network_type,
  ms.access_tech,
  
  -- Modem information
  m.equipment_id as imei,
  m.equipment_id as modem_id,
  m.manufacturer as modem_manufacturer,
  m.model as modem_model,
  m.firmware_revision,
  m.usb_port,
  m.modem_index,
  m.status as modem_status,
  m.error_count as modem_error_count,
  m.last_error as modem_last_error,
  
  -- SIM information
  s.iccid as sim_iccid,
  s.phone_number as sim_phone_number,
  s.status as sim_status,
  s.activation_date as sim_activation_date,
  s.sim_index,
  
  -- Timestamps
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
  CASE WHEN m.usb_port IS NOT NULL THEN m.usb_port ELSE 999 END,
  s.iccid;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sims_modem_lookup ON sims(current_modem_id, status);
CREATE INDEX IF NOT EXISTS idx_modem_state_lookup ON modem_state(modem_id, updated_at DESC);

-- Create stats view for quick aggregation
CREATE VIEW IF NOT EXISTS device_stats AS
SELECT 
  COUNT(DISTINCT m.equipment_id) as total_modems,
  COUNT(DISTINCT CASE WHEN m.status = 'connected' THEN m.equipment_id END) as connected_modems,
  COUNT(DISTINCT s.iccid) as total_sims,
  COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.iccid END) as active_sims,
  COUNT(DISTINCT CASE 
    WHEN m.status = 'connected' AND s.status = 'active' AND ms.connection_status = 'registered' 
    THEN m.equipment_id 
  END) as online_devices,
  AVG(CASE WHEN ms.signal_percent IS NOT NULL THEN ms.signal_percent END) as avg_signal_strength
FROM modems m
LEFT JOIN sims s ON s.current_modem_id = m.equipment_id
LEFT JOIN modem_state ms ON ms.modem_id = m.equipment_id;

-- Migration already logged