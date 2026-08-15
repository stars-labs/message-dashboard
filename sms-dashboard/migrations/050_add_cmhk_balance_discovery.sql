-- Discovery-only CMHK SMS profile. Official CMHK documentation identifies
-- sending "0" to 12580 as the free SMS service-hall entry point. The runtime
-- skill may follow only read-only account/balance menu options returned by 12580.

INSERT OR IGNORE INTO sim_balance_profiles (
    id, country_code, carrier, method, command, destination,
    expected_senders, parser_version, response_window_minutes,
    discovery_enabled, enabled, conversation_steps, skill_config
) VALUES (
    'hk-cmhk-sms-menu-v1',
    'HK',
    'CMHK',
    'sms',
    '0',
    '12580',
    '["12580"]',
    'hk-cmhk-balance-v1',
    30,
    1,
    0,
    '[]',
    '{"id":"readonly-balance-menu","version":"1","objective":"查询当前可用现金储值额；如果回复只提供数据用量、套餐或活动则停止","confidence_threshold":0.85,"max_turns":4,"allowed_currencies":["HKD"],"forbidden_intents":["增值","充值","缴费","订购","退订","办理","开通","购买","套餐变更","活动"]}'
);
