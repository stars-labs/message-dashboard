-- Promote the read-only 102 command after successful validation across the
-- current China Telecom fleet. Keep the menu profile available for discovery.

UPDATE sim_balance_profiles
SET enabled = 1,
    discovery_enabled = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cn-telecom-sms-102-v1';

UPDATE sim_balance_profiles
SET enabled = 0,
    discovery_enabled = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cn-telecom-sms-menu-v1';
