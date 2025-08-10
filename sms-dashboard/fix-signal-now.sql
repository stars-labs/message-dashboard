-- Direct fix for modem 29 signal data
-- Run this with: npx wrangler d1 execute sms-dashboard --file=fix-signal-now.sql --remote

INSERT INTO modem_state (modem_id, connection_status, signal_percent, rssi, rsrq, rsrp, snr, updated_at)
VALUES ('865827078904323', 'registered', 100, -44, -4, -68, 30, CURRENT_TIMESTAMP)
ON CONFLICT(modem_id) DO UPDATE SET
  connection_status = 'registered',
  signal_percent = 100,
  rssi = -44,
  rsrq = -4,
  rsrp = -68,
  snr = 30,
  updated_at = CURRENT_TIMESTAMP;