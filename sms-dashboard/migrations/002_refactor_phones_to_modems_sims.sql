-- Migration 002: Refactor phones table into modems and sims tables
-- This migration creates the new schema without dropping existing tables
-- to allow for gradual migration and backward compatibility

-- Step 1: Create modems table for hardware tracking
CREATE TABLE IF NOT EXISTS modems (
    equipment_id TEXT PRIMARY KEY,        -- IMEI from mmcli (e.g., "865827078383361")
    manufacturer TEXT,                    -- e.g., "QUALCOMM INCORPORATED"
    model TEXT,                           -- e.g., "QUECTEL Mobile Broadband Module"
    firmware_revision TEXT,               -- e.g., "EC20CEHDLGR08A02M1G"
    hardware_revision TEXT,               -- e.g., "10000"
    device_path TEXT,                     -- e.g., "/org/freedesktop/ModemManager1/Modem/66"
    usb_port INTEGER,                     -- Physical USB port number
    modem_index INTEGER,                  -- mmcli modem index (transient)
    status TEXT DEFAULT 'disconnected',  -- connected, disconnected, error
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 2: Create sims table for SIM card tracking
CREATE TABLE IF NOT EXISTS sims (
    iccid TEXT PRIMARY KEY,              -- SIM card identifier
    phone_number TEXT,                   -- Phone number assigned to SIM
    country_code TEXT,                   -- ISO country code
    carrier TEXT,                        -- Carrier name
    operator_name TEXT,                  -- Current operator
    operator_id TEXT,                    -- MCC/MNC
    current_modem_id TEXT,               -- FK to modems.equipment_id
    status TEXT DEFAULT 'inactive',      -- active, inactive, removed
    activation_date TIMESTAMP,
    deactivation_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (current_modem_id) REFERENCES modems(equipment_id) ON DELETE SET NULL
);

-- Step 3: Create modem-SIM association history
CREATE TABLE IF NOT EXISTS modem_sim_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modem_id TEXT NOT NULL,
    sim_iccid TEXT NOT NULL,
    inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP,
    signal_quality INTEGER,              -- Last known signal quality
    network_type TEXT,                   -- Last known network type (GSM, LTE, etc.)
    access_tech TEXT,                    -- Last known access technology
    FOREIGN KEY (modem_id) REFERENCES modems(equipment_id) ON DELETE CASCADE,
    FOREIGN KEY (sim_iccid) REFERENCES sims(iccid) ON DELETE CASCADE
);

-- Step 4: Create real-time modem state table (volatile data)
CREATE TABLE IF NOT EXISTS modem_state (
    modem_id TEXT PRIMARY KEY,
    signal_percent INTEGER,
    rssi INTEGER,
    rsrq INTEGER,
    rsrp INTEGER,
    snr INTEGER,
    network_type TEXT,
    access_tech TEXT,
    connection_status TEXT,              -- registered, searching, denied
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (modem_id) REFERENCES modems(equipment_id) ON DELETE CASCADE
);

-- Step 5: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sims_current_modem ON sims(current_modem_id);
CREATE INDEX IF NOT EXISTS idx_sims_status ON sims(status);
CREATE INDEX IF NOT EXISTS idx_modems_status ON modems(status);
CREATE INDEX IF NOT EXISTS idx_modems_usb_port ON modems(usb_port);
CREATE INDEX IF NOT EXISTS idx_modem_sim_history_dates ON modem_sim_history(inserted_at, removed_at);
CREATE INDEX IF NOT EXISTS idx_modem_state_updated ON modem_state(updated_at);

-- Step 6: Create triggers for automatic timestamp updates
CREATE TRIGGER IF NOT EXISTS update_modems_timestamp 
AFTER UPDATE ON modems
BEGIN
    UPDATE modems SET updated_at = CURRENT_TIMESTAMP WHERE equipment_id = NEW.equipment_id;
END;

CREATE TRIGGER IF NOT EXISTS update_sims_timestamp 
AFTER UPDATE ON sims
BEGIN
    UPDATE sims SET updated_at = CURRENT_TIMESTAMP WHERE iccid = NEW.iccid;
END;

CREATE TRIGGER IF NOT EXISTS update_modem_state_timestamp 
AFTER UPDATE ON modem_state
BEGIN
    UPDATE modem_state SET updated_at = CURRENT_TIMESTAMP WHERE modem_id = NEW.modem_id;
END;

-- Step 7: Create trigger for SIM swap detection
CREATE TRIGGER IF NOT EXISTS sim_swap_detection
AFTER UPDATE ON sims
WHEN OLD.current_modem_id != NEW.current_modem_id OR 
     (OLD.current_modem_id IS NULL AND NEW.current_modem_id IS NOT NULL) OR
     (OLD.current_modem_id IS NOT NULL AND NEW.current_modem_id IS NULL)
BEGIN
    -- Close previous association if exists
    UPDATE modem_sim_history 
    SET removed_at = CURRENT_TIMESTAMP
    WHERE modem_id = OLD.current_modem_id 
      AND sim_iccid = NEW.iccid
      AND removed_at IS NULL;
    
    -- Create new association if SIM is inserted into a modem
    INSERT INTO modem_sim_history (modem_id, sim_iccid)
    SELECT NEW.current_modem_id, NEW.iccid
    WHERE NEW.current_modem_id IS NOT NULL;
END;

-- Step 8: Add version tracking for migration
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

INSERT INTO schema_version (version, description) 
VALUES (2, 'Refactor phones table into modems and sims tables');