-- Migration 063: replace the ambiguous `n/a` service type with
-- `balance_managed`, whose name matches the operational behavior.

PRAGMA foreign_keys=OFF;

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
    CHECK(service_type IN ('unknown', 'prepaid', 'postpaid', 'balance_managed')),
  service_type_source TEXT
    CHECK(service_type_source IS NULL OR service_type_source IN (
      'carrier_account', 'carrier_support', 'contract_or_bill', 'carrier_message'
    )),
  service_type_verified_at TIMESTAMP,
  sim_role TEXT NOT NULL DEFAULT 'standalone'
    CHECK(sim_role IN ('standalone', 'primary', 'secondary')),
  primary_iccid TEXT
    REFERENCES sims(iccid) ON DELETE RESTRICT,
  balance_threshold REAL
);

INSERT INTO sims_new (
  iccid, sim_index, phone_number, country_code, carrier, imei, notes,
  created_at, updated_at, updated_by,
  service_type, service_type_source, service_type_verified_at,
  sim_role, primary_iccid, balance_threshold
)
SELECT
  iccid, sim_index, phone_number, country_code, carrier, imei, notes,
  created_at, updated_at, updated_by,
  CASE WHEN service_type = 'n/a' THEN 'balance_managed' ELSE service_type END,
  service_type_source, service_type_verified_at,
  sim_role, primary_iccid, balance_threshold
FROM sims;

DROP TABLE sims;

ALTER TABLE sims_new RENAME TO sims;

CREATE INDEX idx_sims_sim_index ON sims(sim_index);
CREATE UNIQUE INDEX idx_sims_imei_unique ON sims(imei) WHERE imei IS NOT NULL;

CREATE TRIGGER validate_sim_service_type_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.service_type IN ('unknown', 'balance_managed')
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
  (NEW.service_type IN ('unknown', 'balance_managed')
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

CREATE TRIGGER validate_sim_role_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary' AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;

CREATE TRIGGER validate_sim_role_update
BEFORE UPDATE OF sim_role, primary_iccid ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary' AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;

PRAGMA foreign_key_check;

PRAGMA foreign_keys=ON;
