-- Migration 006: Drop the legacy phones table
-- The phones table has been replaced by modems and sims tables
-- device_view provides backward compatibility

-- Drop the phones table
DROP TABLE IF EXISTS phones;