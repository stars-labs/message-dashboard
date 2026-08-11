-- Migration 037: classify carrier broadcasts that were previously mistaken for
-- verification codes because their bodies contain the year 2026.

INSERT OR IGNORE INTO filter_rules (rule_type, pattern, note) VALUES
    ('sender', 'M1 Limited', 'M1 carrier broadcasts and marketing'),
    ('sender', '10001',      '中国电信漫游通知/营销');
