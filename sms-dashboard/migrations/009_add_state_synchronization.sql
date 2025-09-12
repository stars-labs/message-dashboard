-- Migration 009: Add state synchronization support
-- This migration adds columns and tables needed for proper daemon state reconciliation

-- Step 1: Enhance daemon_health table for session tracking
ALTER TABLE daemon_health ADD COLUMN current_session_id TEXT;
ALTER TABLE daemon_health ADD COLUMN last_full_sync TIMESTAMP;
ALTER TABLE daemon_health ADD COLUMN sync_mode TEXT DEFAULT 'incremental';

-- Step 2: Add verification tracking to modems table
ALTER TABLE modems ADD COLUMN last_verified_session TEXT;
ALTER TABLE modems ADD COLUMN verification_status TEXT DEFAULT 'unverified';

-- Step 3: Add verification tracking to sims table  
ALTER TABLE sims ADD COLUMN last_verified_session TEXT;
ALTER TABLE sims ADD COLUMN sim_index INTEGER; -- Add if not exists

-- Step 4: Create sync_history table for audit trail
CREATE TABLE IF NOT EXISTS sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    daemon_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sync_mode TEXT NOT NULL,
    sync_timestamp TIMESTAMP NOT NULL,
    modems_received INTEGER DEFAULT 0,
    sims_received INTEGER DEFAULT 0,
    modems_verified INTEGER DEFAULT 0,
    modems_disconnected INTEGER DEFAULT 0,
    sims_reassigned INTEGER DEFAULT 0,
    duration_ms INTEGER,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (daemon_id) REFERENCES daemon_health(daemon_id)
);

-- Step 5: Enhance modem_sim_history for better tracking
-- Check if columns exist before adding (some deployments may have them)
-- SQLite doesn't support conditional ALTER TABLE, so we'll handle errors in deployment

-- Step 6: Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_modems_verification ON modems(verification_status, last_verified_session);
CREATE INDEX IF NOT EXISTS idx_sims_verification ON sims(last_verified_session);
CREATE INDEX IF NOT EXISTS idx_sync_history_session ON sync_history(session_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_daemon ON sync_history(daemon_id, sync_timestamp DESC);

-- Step 7: Create trigger to auto-record SIM movements
DROP TRIGGER IF EXISTS record_sim_movement;
CREATE TRIGGER record_sim_movement
AFTER UPDATE ON sims
WHEN OLD.current_modem_id IS DISTINCT FROM NEW.current_modem_id
BEGIN
  -- Record removal from old modem
  UPDATE modem_sim_history 
  SET removed_at = CURRENT_TIMESTAMP
  WHERE sim_iccid = NEW.iccid 
    AND modem_id = OLD.current_modem_id
    AND removed_at IS NULL;
  
  -- Record insertion to new modem (if not NULL)
  INSERT INTO modem_sim_history (
    modem_id, sim_iccid, inserted_at, signal_quality, network_type, access_tech
  ) 
  SELECT 
    NEW.current_modem_id, 
    NEW.iccid, 
    CURRENT_TIMESTAMP,
    ms.signal_percent,
    ms.network_type,
    ms.access_tech
  FROM modem_state ms
  WHERE ms.modem_id = NEW.current_modem_id
    AND NEW.current_modem_id IS NOT NULL;
END;

-- Step 8: Create cleanup trigger for old sync records (keep 30 days)
DROP TRIGGER IF EXISTS cleanup_old_sync_history;
CREATE TRIGGER cleanup_old_sync_history
AFTER INSERT ON sync_history
BEGIN
  DELETE FROM sync_history 
  WHERE created_at < datetime('now', '-30 days');
END;

-- Step 9: Initialize verification status for existing records
UPDATE modems SET verification_status = 'unverified' WHERE verification_status IS NULL;
UPDATE modems SET verification_status = 'verified' WHERE status = 'connected';