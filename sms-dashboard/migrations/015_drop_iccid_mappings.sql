-- Migration 015: Drop dead iccid_mappings table
-- The table has been unused since migration 006 (fix_normalization) which merged
-- its data into sims.user_* columns. The /api/iccid-mappings handler queries
-- sims directly. The table has 0 rows and no code references it.

DROP TABLE IF EXISTS iccid_mappings;

INSERT INTO schema_version (version, description, applied_at)
VALUES (15, 'Drop unused iccid_mappings table (superseded by sims.user_* columns)', CURRENT_TIMESTAMP);
