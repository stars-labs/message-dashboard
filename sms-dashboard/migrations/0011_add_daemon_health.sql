-- Add daemon health tracking table
CREATE TABLE IF NOT EXISTS daemon_health (
    daemon_id TEXT PRIMARY KEY, -- e.g., 'orange-pi-main'
    last_heartbeat TIMESTAMP NOT NULL,
    status TEXT DEFAULT 'online' CHECK(status IN ('online', 'offline', 'warning')),
    last_ip TEXT,
    version TEXT,
    modem_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    metadata TEXT, -- JSON string for additional data
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_daemon_health_heartbeat ON daemon_health(last_heartbeat);

-- Insert default daemon entry
INSERT OR IGNORE INTO daemon_health (daemon_id, last_heartbeat, status) 
VALUES ('orange-pi-main', CURRENT_TIMESTAMP, 'offline');