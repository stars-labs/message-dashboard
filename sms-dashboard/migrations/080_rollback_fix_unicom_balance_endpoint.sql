-- Rollback for 080_fix_unicom_balance_endpoint.sql
--
-- Restores the previous China Unicom browser balance endpoint. Only run this if
-- the new endpoint is wrong (for example a province serves a different payload).
--
-- Apply with:
--   bunx wrangler d1 execute sms-dashboard --remote \
--     --file=migrations/080_rollback_fix_unicom_balance_endpoint.sql
--
-- Note: this reverts data only. The matching agent change (origin allowlist,
-- curntbalancecust extraction) is code and is not reverted by this file. Once
-- rolled back, the agent must also be rebuilt from a revert of the code change
-- or queries fail with "did not return JSON" again.

UPDATE sim_balance_profiles
SET skill_config = json_set(
      skill_config,
      '$.query_endpoint', 'https://www.10010.com/mall/service/query/userinfoquery'
    )
WHERE id = 'cn-unicom-browser-random-password-v1'
  AND method = 'browser'
  AND country_code = 'CN'
  AND carrier = 'China Unicom';