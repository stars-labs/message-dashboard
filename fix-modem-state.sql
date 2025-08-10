-- Fix modem_state for modem 29 that has signal data
INSERT INTO modem_state (modem_id, connection_status, signal_percent, rssi, rsrq, rsrp, snr, updated_at) 
VALUES ('865827078904323', 'registered', 100, -44, -4, -68, 30, CURRENT_TIMESTAMP) 
ON CONFLICT(modem_id) DO UPDATE SET 
  connection_status = excluded.connection_status, 
  signal_percent = excluded.signal_percent, 
  rssi = excluded.rssi, 
  rsrq = excluded.rsrq, 
  rsrp = excluded.rsrp, 
  snr = excluded.snr, 
  updated_at = CURRENT_TIMESTAMP;