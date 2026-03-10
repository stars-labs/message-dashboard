-- Migration 030: Rebuild sims table with user-authoritative schema
-- Removes dual-field pattern (user_* overrides) and separates concerns:
-- - sims table = user inventory (10 columns)
-- - modems table = daemon hardware state (adds current_iccid, operator, detected_phone_number)
-- Status is computed dynamically, not stored

-- Step 1: Drop existing table and dependencies
DROP VIEW IF EXISTS device_view;
DROP TRIGGER IF EXISTS update_sims_timestamp;
DROP TABLE IF EXISTS sims;

-- Step 2: Create new ultra-simplified sims table (NO status field - computed dynamically)
CREATE TABLE sims (
  iccid TEXT PRIMARY KEY,
  sim_index INTEGER NOT NULL,       -- Physical slot 1-95 (user-maintained)
  phone_number TEXT NOT NULL,       -- User-provided phone number
  country_code TEXT,                -- User-provided country code (CN, SG, etc.)
  carrier TEXT,                     -- User-provided carrier (联通, M1, etc.)
  imei TEXT,                        -- User-assigned modem IMEI (intended binding)
  notes TEXT,                       -- User notes about this SIM
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT                   -- User email who last edited
);

CREATE INDEX idx_sims_imei ON sims(imei);
CREATE INDEX idx_sims_sim_index ON sims(sim_index);

-- Step 3: Add daemon fields to modems table
ALTER TABLE modems ADD COLUMN current_iccid TEXT;           -- Which SIM is currently inserted
ALTER TABLE modems ADD COLUMN detected_phone_number TEXT;   -- Phone number from AT+CNUM
ALTER TABLE modems ADD COLUMN operator TEXT;                -- Network operator from AT+COPS

CREATE INDEX idx_modems_current_iccid ON modems(current_iccid);

-- Step 4: Recreate device_view with new schema (status computed dynamically)
CREATE VIEW device_view AS
SELECT
  m.equipment_id as id,
  m.equipment_id,
  m.manufacturer,
  m.model,
  m.usb_port as primary_port,         -- Use usb_port for backward compatibility
  m.status as modem_status,
  s.iccid,
  s.phone_number as number,
  s.carrier,
  s.country_code as country,
  m.operator,                         -- Now from modems table (daemon-provided)
  CASE
    WHEN m.current_iccid IS NOT NULL THEN 'active'
    ELSE 'inactive'
  END as sim_status,                  -- Computed: active if modem has this SIM
  s.sim_index,
  s.notes,
  ms.signal_percent as signal_quality,  -- Rename for backward compatibility
  ms.connection_status,
  ms.network_type,
  m.created_at,
  s.updated_at
FROM modems m
LEFT JOIN sims s ON m.current_iccid = s.iccid  -- Join on daemon's detected SIM
LEFT JOIN modem_state ms ON ms.modem_id = m.equipment_id;
