-- The S01 pilot showed that sending 10010 to 10010 does not return a menu.
-- Permit the one exact text fallback approved by the carrier discovery plan,
-- and only after the observed "not understood" response.

UPDATE sim_balance_profiles
SET conversation_steps = '[{"response_contains":"未能理解您要办的业务","command":"余额"}]',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cn-unicom-sms-menu-v1';
