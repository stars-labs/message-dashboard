-- SIM-offline alerts were dropped: a SIM going offline is not urgent, a silent
-- daemon is. The table holds only transient state, so it is recreated empty with
-- a CHECK that names the one alert left.
DROP TABLE alert_state;

CREATE TABLE alert_state (
  alert TEXT PRIMARY KEY CHECK (alert = 'daemon_offline'),
  first_seen_at TEXT NOT NULL,
  notified_at TEXT
);
