-- Migration 041: S02 live menu confirms the direct balance command

UPDATE sim_balance_profiles
SET conversation_steps = '[{"response_contains":"1.话费与AI豆","command":"1"},{"response_contains":"101.查询余额","command":"101"}]',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cn-mobile-sms-menu-v1';
