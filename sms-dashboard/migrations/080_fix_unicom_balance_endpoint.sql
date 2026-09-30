-- The China Unicom random-password portal moved its balance call. The profile
-- still pointed at https://www.10010.com/mall/service/query/userinfoquery,
-- which now answers HTTP 200 with an empty body (content-type application/json),
-- so the agent failed the job with "did not return JSON".
--
-- Captured network trace from a successful manual login shows the portal posting
-- the balance request to a different host and path:
--   POST https://mxx.client.10010.com/servicequerybusiness/balancenew/accountBalancenew.htm
--   -> {"curntbalancecust":"182.40", ...}
--
-- query_origin stays the portal origin used for the request's Referer/Origin
-- headers; query_endpoint is the actual balance API. The extractor and the job
-- validator are updated in the same change.

UPDATE sim_balance_profiles
SET skill_config = json_set(
      skill_config,
      '$.query_endpoint', 'https://mxx.client.10010.com/servicequerybusiness/balancenew/accountBalancenew.htm'
    )
WHERE id = 'cn-unicom-browser-random-password-v1'
  AND method = 'browser'
  AND country_code = 'CN'
  AND carrier = 'China Unicom';