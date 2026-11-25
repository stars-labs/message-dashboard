-- modems.current_iccid stopped being written when the daemon moved to
-- detected_iccid; no code reads it. SQLite refuses to drop an indexed column,
-- so the index goes first.
--
-- Apply with:
--   bunx wrangler d1 execute sms-dashboard --remote \
--     --file=migrations/081_drop_modems_current_iccid.sql

DROP INDEX IF EXISTS idx_modems_current_iccid;
ALTER TABLE modems DROP COLUMN current_iccid;
