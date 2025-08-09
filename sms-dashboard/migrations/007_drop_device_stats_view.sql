-- Drop the device_stats view as we're using a simpler approach now
-- Device counts are calculated directly from modems/sims tables

DROP VIEW IF EXISTS device_stats;