-- Migration 060: Add 'n/a' service_type for SIMs where billing type is not applicable
-- (e.g. CN SIMs whose balance query path does not depend on service type)
--
-- SQLite does not support ALTER COLUMN on a CHECK constraint. We rebuild `sims`
-- using the standard 12-step table-rebuild procedure (https://www.sqlite.org/lang_altertable.html):
--
-- D1 wraps each --file execution in its own transaction and forbids explicit
-- BEGIN/COMMIT, so we omit them. D1 does honor PRAGMA foreign_keys=OFF within
-- the file's transaction (verified 2026-08-18): it disables FK enforcement
-- including the implicit DELETE that DROP TABLE issues, so the ON DELETE
-- RESTRICT on sim_balance_checks.sim_iccid does not abort the rebuild.

PRAGMA foreign_keys=OFF;

-- Drop device_view BEFORE the table rebuild. The existing view (from migration
-- 059) references sims; DROP TABLE sims would otherwise try to recompile it
-- against the mid-rebuild schema and abort with "no such table: main.sims".
-- The view is recreated in migration 061 once the new table is committed.
DROP VIEW IF EXISTS device_view;

CREATE TABLE sims_new (
  iccid TEXT PRIMARY KEY,
  sim_index INTEGER NOT NULL,
  phone_number TEXT NOT NULL,
  country_code TEXT,
  carrier TEXT,
  imei TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  service_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK(service_type IN ('unknown', 'prepaid', 'postpaid', 'n/a')),
  service_type_source TEXT
    CHECK(service_type_source IS NULL OR service_type_source IN (
      'carrier_account', 'carrier_support', 'contract_or_bill', 'carrier_message'
    )),
  service_type_verified_at TIMESTAMP,
  sim_role TEXT NOT NULL DEFAULT 'standalone'
    CHECK(sim_role IN ('standalone', 'primary', 'secondary')),
  primary_iccid TEXT
    REFERENCES sims(iccid) ON DELETE RESTRICT
);

INSERT INTO sims_new SELECT * FROM sims;

DROP TABLE sims;

ALTER TABLE sims_new RENAME TO sims;

-- Recreate indexes (DROP TABLE destroyed them)
CREATE INDEX idx_sims_sim_index ON sims(sim_index);
CREATE UNIQUE INDEX idx_sims_imei_unique ON sims(imei) WHERE imei IS NOT NULL;

-- Recreate service_type validation triggers, updated so 'n/a' (like 'unknown')
-- requires no source or verified_at. 'prepaid'/'postpaid' keep requiring both.
CREATE TRIGGER validate_sim_service_type_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.service_type IN ('unknown', 'n/a')
    AND NEW.service_type_source IS NULL
    AND NEW.service_type_verified_at IS NULL)
  OR
  (NEW.service_type IN ('prepaid', 'postpaid')
    AND NEW.service_type_source IS NOT NULL
    AND NEW.service_type_verified_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid SIM service type verification metadata');
END;

CREATE TRIGGER validate_sim_service_type_update
BEFORE UPDATE OF service_type, service_type_source, service_type_verified_at ON sims
WHEN NOT (
  (NEW.service_type IN ('unknown', 'n/a')
    AND NEW.service_type_source IS NULL
    AND NEW.service_type_verified_at IS NULL)
  OR
  (NEW.service_type IN ('prepaid', 'postpaid')
    AND NEW.service_type_source IS NOT NULL
    AND NEW.service_type_verified_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid SIM service type verification metadata');
END;

-- Recreate sim_role validation triggers (unchanged from migration 059)
CREATE TRIGGER validate_sim_role_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary'    AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary'  AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;

CREATE TRIGGER validate_sim_role_update
BEFORE UPDATE OF sim_role, primary_iccid ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary'    AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary'  AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;

-- Bulk-set all CN SIMs to 'n/a' (balance query path does not use service_type).
-- The trigger requires source/verified_at to be NULL for 'n/a', so set both NULL.
UPDATE sims SET service_type = 'n/a', service_type_source = NULL, service_type_verified_at = NULL
WHERE country_code = 'CN' AND service_type = 'unknown';

-- device_view is recreated in migration 061. D1 compiles a CREATE VIEW against
-- the schema cached at the start of the transaction; within the same
-- transaction as the table rebuild (DROP + RENAME), that cache still holds the
-- pre-rebuild sims table and raises "no such table: main.sims" (verified
-- 2026-08-18). Running it in a separate file/transaction sees the committed
-- new schema. The existing device_view definition is schema-compatible (same
-- columns), so it continues to work against the rebuilt table in the interim.

-- Integrity gate: any FK violation aborts the file's transaction; D1 rolls back.
PRAGMA foreign_key_check;

PRAGMA foreign_keys=ON;
