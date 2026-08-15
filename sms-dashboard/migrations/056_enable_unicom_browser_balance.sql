-- The China Unicom random-password browser workflow has completed an end-to-end
-- production validation. Enable it for normal single-SIM and fleet queries.
-- Browser jobs remain serialized by the Balance Agent capability concurrency.

UPDATE sim_balance_profiles
SET discovery_enabled = 1,
    enabled = 1
WHERE id = 'cn-unicom-browser-random-password-v1'
  AND method = 'browser'
  AND country_code = 'CN'
  AND carrier = 'China Unicom';
