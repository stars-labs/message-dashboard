-- One row per alert condition that currently holds. The row is written when the
-- condition is first seen, updated when an email goes out, and deleted when the
-- condition clears, so the table stays empty while everything is healthy.
CREATE TABLE alert_state (
  alert TEXT PRIMARY KEY CHECK (alert IN ('daemon_offline', 'sims_offline')),
  first_seen_at TEXT NOT NULL,
  notified_at TEXT
);
