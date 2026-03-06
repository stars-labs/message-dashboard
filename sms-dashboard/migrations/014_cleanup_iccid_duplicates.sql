-- Migration 014: Clean up duplicate ICCID records caused by trailing 'F' BCD padding
-- Issue: ISSUES.md #1 — 23 duplicate SIM pairs (with/without trailing F)
-- Strategy: Keep canonical (no F) version, migrate references, delete F version
--
-- Per ITU-T E.118, ICCID is max 19-20 digits stored as packed BCD (10 octets).
-- Trailing 'F' is a storage filler, not part of the actual identifier.
-- The daemon was reading ICCIDs via AT commands (with F) and D-Bus (without F),
-- creating two SIM records for the same physical card.
--
-- HOW TO APPLY:
--
--   1. Dry-run locally (if you have a local D1 copy):
--      npx wrangler d1 execute sms-dashboard --local --file=sms-dashboard/migrations/014_cleanup_iccid_duplicates.sql
--
--   2. Verify counts before running on production:
--      npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) as f_suffixed_sims FROM sims WHERE iccid LIKE '%F' AND LENGTH(iccid) = 20"
--
--   3. Apply to production:
--      npx wrangler d1 execute sms-dashboard --remote --file=sms-dashboard/migrations/014_cleanup_iccid_duplicates.sql
--
--   4. Verify after:
--      npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM sims"
--      (Should drop from 121 to ~98)

-- Step 1: Migrate messages.phone_iccid from F-suffixed to canonical (strip last char)
-- Only where the canonical version exists in sims
UPDATE messages
SET phone_iccid = SUBSTR(phone_iccid, 1, LENGTH(phone_iccid) - 1),
    updated_at = CURRENT_TIMESTAMP
WHERE phone_iccid LIKE '%F'
  AND LENGTH(phone_iccid) = 20
  AND SUBSTR(phone_iccid, 1, LENGTH(phone_iccid) - 1) IN (
    SELECT iccid FROM sims WHERE iccid NOT LIKE '%F'
  );

-- Step 2: Migrate modem_sim_history.sim_iccid references
UPDATE modem_sim_history
SET sim_iccid = SUBSTR(sim_iccid, 1, LENGTH(sim_iccid) - 1)
WHERE sim_iccid LIKE '%F'
  AND LENGTH(sim_iccid) = 20
  AND SUBSTR(sim_iccid, 1, LENGTH(sim_iccid) - 1) IN (
    SELECT iccid FROM sims WHERE iccid NOT LIKE '%F'
  );

-- Step 3: Migrate iccid_mappings.iccid references
UPDATE iccid_mappings
SET iccid = SUBSTR(iccid, 1, LENGTH(iccid) - 1)
WHERE iccid LIKE '%F'
  AND LENGTH(iccid) = 20
  AND SUBSTR(iccid, 1, LENGTH(iccid) - 1) IN (
    SELECT iccid FROM sims WHERE iccid NOT LIKE '%F'
  );

-- Step 4: For canonical SIM records, fill in any NULL fields from the F-suffixed duplicate
-- (SQLite doesn't support UPDATE...FROM, so we use correlated subqueries)
UPDATE sims
SET phone_number = COALESCE(phone_number,
      (SELECT phone_number FROM sims AS dup WHERE dup.iccid = sims.iccid || 'F')),
    carrier = COALESCE(carrier,
      (SELECT carrier FROM sims AS dup WHERE dup.iccid = sims.iccid || 'F')),
    country_code = COALESCE(country_code,
      (SELECT country_code FROM sims AS dup WHERE dup.iccid = sims.iccid || 'F')),
    operator_name = COALESCE(operator_name,
      (SELECT operator_name FROM sims AS dup WHERE dup.iccid = sims.iccid || 'F')),
    operator_id = COALESCE(operator_id,
      (SELECT operator_id FROM sims AS dup WHERE dup.iccid = sims.iccid || 'F')),
    updated_at = CURRENT_TIMESTAMP
WHERE iccid NOT LIKE '%F'
  AND (iccid || 'F') IN (SELECT iccid FROM sims WHERE iccid LIKE '%F');

-- Step 5: Delete the F-suffixed duplicate SIM records
DELETE FROM sims
WHERE iccid LIKE '%F'
  AND LENGTH(iccid) = 20
  AND SUBSTR(iccid, 1, LENGTH(iccid) - 1) IN (
    SELECT iccid FROM sims WHERE iccid NOT LIKE '%F'
  );

-- Step 6: Record migration
INSERT INTO schema_version (version, description, applied_at)
VALUES (14, 'Clean up 23 duplicate ICCID records with trailing F BCD padding', CURRENT_TIMESTAMP);
