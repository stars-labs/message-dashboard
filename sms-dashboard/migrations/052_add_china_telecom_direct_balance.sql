-- Discovery-only direct balance command for Guangdong China Telecom.
-- Guangdong Telecom documents 102 -> 10001 as a read-only balance query.

INSERT OR IGNORE INTO sim_balance_profiles (
    id, country_code, carrier, method, command, destination,
    expected_senders, parser_version, response_window_minutes,
    discovery_enabled, enabled, conversation_steps, skill_config
) VALUES (
    'cn-telecom-sms-102-v1',
    'CN',
    'China Telecom',
    'sms',
    '102',
    '10001',
    '["10001"]',
    'cn-telecom-balance-v1',
    30,
    1,
    0,
    '[]',
    '{"id":"readonly-balance-direct","version":"1","objective":"解析当前可用现金话费余额；如果回复不包含现金余额则停止","confidence_threshold":0.9,"max_turns":1,"allowed_currencies":["CNY"],"forbidden_intents":["充值","缴费","订购","退订","办理","开通","购买","套餐变更","活动"]}'
);
