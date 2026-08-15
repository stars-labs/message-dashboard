-- China Unicom's official SMS command table identifies 102 as the read-only
-- "available balance" query. Permit it only after the S01 text fallback returns
-- the observed app-only response.

UPDATE sim_balance_profiles
SET conversation_steps = '[{"response_contains":"未能理解您要办的业务","command":"余额"},{"response_contains":"跳转到中国联通APP查询当前话费使用情况","command":"102"}]',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cn-unicom-sms-menu-v1';
