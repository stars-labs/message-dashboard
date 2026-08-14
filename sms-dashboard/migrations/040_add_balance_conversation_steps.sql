-- Migration 040: allowlisted, multi-step balance-query conversations

ALTER TABLE sim_balance_profiles ADD COLUMN conversation_steps TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(conversation_steps));

ALTER TABLE sim_balance_checks ADD COLUMN step_index INTEGER NOT NULL DEFAULT 0
    CHECK(step_index >= 0);

-- The live S02 menu returned this exact option. Only this discovered transition
-- is permitted; arbitrary replies remain impossible through the balance API.
UPDATE sim_balance_profiles
SET conversation_steps = '[{"response_contains":"1.话费与AI豆","command":"1"}]',
    parser_version = 'cn-mobile-balance-v1',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cn-mobile-sms-menu-v1';

-- The S02 discovery check already captured the first menu using the previous
-- parser snapshot. Upgrade that profile's unfinished/menu-only checks so the
-- final reply can produce a typed cash-balance metric.
UPDATE sim_balance_checks
SET parser_version = 'cn-mobile-balance-v1',
    updated_at = CURRENT_TIMESTAMP
WHERE profile_id = 'cn-mobile-sms-menu-v1'
  AND parser_version = 'cn-mobile-menu-v1'
  AND status IN ('queued', 'awaiting_response', 'response_received', 'unparsed');
