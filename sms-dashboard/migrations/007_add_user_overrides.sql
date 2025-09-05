-- Migration 007: Add user override fields to sims table
-- Date: 2025-09-05
-- Purpose: Allow users to override phone numbers while maintaining 3NF compliance

-- Add user override columns to sims table
ALTER TABLE sims ADD COLUMN user_phone_number TEXT;
ALTER TABLE sims ADD COLUMN user_carrier TEXT;  
ALTER TABLE sims ADD COLUMN user_country_code TEXT;
ALTER TABLE sims ADD COLUMN user_notes TEXT;
ALTER TABLE sims ADD COLUMN user_override_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE sims ADD COLUMN user_updated_at TIMESTAMP;
ALTER TABLE sims ADD COLUMN user_updated_by TEXT;

-- Migrate existing active mappings from deprecated table
UPDATE sims 
SET 
    user_phone_number = (
        SELECT phone_number 
        FROM iccid_mappings_deprecated 
        WHERE iccid = sims.iccid AND is_active = 1
    ),
    user_carrier = (
        SELECT carrier 
        FROM iccid_mappings_deprecated 
        WHERE iccid = sims.iccid AND is_active = 1
    ),
    user_country_code = (
        SELECT country 
        FROM iccid_mappings_deprecated 
        WHERE iccid = sims.iccid AND is_active = 1
    ),
    user_notes = (
        SELECT notes 
        FROM iccid_mappings_deprecated 
        WHERE iccid = sims.iccid AND is_active = 1
    ),
    user_override_enabled = CASE 
        WHEN EXISTS (
            SELECT 1 FROM iccid_mappings_deprecated 
            WHERE iccid = sims.iccid AND is_active = 1
        ) THEN TRUE 
        ELSE FALSE 
    END,
    user_updated_at = (
        SELECT updated_at 
        FROM iccid_mappings_deprecated 
        WHERE iccid = sims.iccid AND is_active = 1
    )
WHERE EXISTS (
    SELECT 1 FROM iccid_mappings_deprecated 
    WHERE iccid = sims.iccid AND is_active = 1
);

-- Create index for user override queries
CREATE INDEX IF NOT EXISTS idx_sims_user_override ON sims(user_override_enabled) WHERE user_override_enabled = TRUE;

-- Update the device_view to use override values when available
DROP VIEW IF EXISTS device_view;
CREATE VIEW device_view AS
SELECT 
  -- Primary identifier (use SIM iccid if available, otherwise modem id)
  COALESCE(s.iccid, 'NO_SIM_' || m.equipment_id) as id,
  
  -- Legacy fields for backward compatibility - now with user overrides
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
  
  -- Status calculation - Fixed to handle 'registered' modem status
  CASE 
    WHEN (m.status = 'connected' OR m.status = 'registered') AND s.status = 'active' AND ms.connection_status = 'registered' THEN 'online'
    WHEN (m.status = 'connected' OR m.status = 'registered') AND s.status = 'active' THEN 'registered'
    WHEN (m.status = 'connected' OR m.status = 'registered') AND s.iccid IS NULL THEN 'sim-missing'
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
  ms.usb_port,
  ms.modem_index,
  m.status as modem_status,
  m.error_count as modem_error_count,
  m.last_error as modem_last_error,
  
  -- SIM information (including user overrides)
  s.iccid as sim_iccid,
  CASE 
    WHEN s.user_override_enabled = TRUE AND s.user_phone_number IS NOT NULL 
    THEN s.user_phone_number 
    ELSE s.phone_number 
  END as sim_phone_number,
  s.status as sim_status,
  s.activation_date as sim_activation_date,
  s.sim_index,
  
  -- User override information
  s.user_phone_number,
  s.user_carrier,
  s.user_country_code,
  s.user_notes,
  s.user_override_enabled,
  s.user_updated_at,
  s.user_updated_by,
  
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
  CASE WHEN ms.usb_port IS NOT NULL THEN CAST(ms.usb_port AS INTEGER) ELSE 999 END,
  s.iccid;

SELECT '✅ Migration 007 completed successfully!' as status;
SELECT 'Added user override fields to sims table and updated device_view' as info;