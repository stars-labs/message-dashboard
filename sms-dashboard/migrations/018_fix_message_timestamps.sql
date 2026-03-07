-- Migration 018: Fix message timestamps
-- The daemon stored China local time (UTC+8) with a 'Z' suffix (falsely claiming UTC).
-- Example: message received at 14:42 CST was stored as "14:42:00.000Z" instead of "06:42:00.000Z".
-- Fix: subtract 8 hours to convert to real UTC, keep 'Z' suffix.

UPDATE messages
SET timestamp = strftime('%Y-%m-%dT%H:%M:%S.000Z',
  datetime(
    substr(timestamp, 1, 19),  -- extract 'YYYY-MM-DDTHH:MM:SS'
    '-8 hours'                 -- subtract 8 hours: CST -> UTC
  )
)
WHERE timestamp LIKE '%Z'
  AND timestamp LIKE '20%';

-- Record schema version
INSERT INTO schema_version (version, description, applied_at)
VALUES (19, 'Fix message timestamps: subtract 8h to convert mislabeled CST to real UTC', CURRENT_TIMESTAMP);
