-- Discovery-only direct China Unicom available-balance command. The official
-- command table lists KYYE as an alias for menu item 102.

INSERT OR IGNORE INTO sim_balance_profiles (
    id, country_code, carrier, method, command, destination,
    expected_senders, parser_version, response_window_minutes,
    discovery_enabled, enabled, conversation_steps, skill_config
) VALUES (
    'cn-unicom-sms-kyye-v1',
    'CN',
    'China Unicom',
    'sms',
    'KYYE',
    '10010',
    '["10010"]',
    'cn-unicom-balance-v1',
    30,
    1,
    0,
    '[]',
    '{"id":"readonly-balance-menu","version":"1","objective":"查询当前可用现金话费余额；如果回复只提供当月话费、欠费或可用额度而非现金余额则停止","confidence_threshold":0.85,"max_turns":2,"allowed_currencies":["CNY"],"forbidden_intents":["充值","缴费","订购","退订","办理","开通","购买","套餐变更","活动"]}'
);
