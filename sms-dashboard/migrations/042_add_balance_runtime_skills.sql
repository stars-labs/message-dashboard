-- Runtime balance skills are executed by an authorised runner inside the company VPN.
-- The Worker owns durable jobs, leases, validation, SMS recipients and auditing.

ALTER TABLE sim_balance_profiles ADD COLUMN skill_config TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(skill_config));

CREATE TABLE IF NOT EXISTS sim_balance_skill_decisions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id            TEXT NOT NULL REFERENCES sim_balance_checks(id) ON DELETE CASCADE,
    response_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    step_index          INTEGER NOT NULL,
    skill_id            TEXT NOT NULL,
    skill_version       TEXT NOT NULL,
    model               TEXT NOT NULL,
    action              TEXT NOT NULL CHECK(action IN ('reply', 'complete', 'stop', 'error')),
    selected_option     TEXT,
    confidence          REAL,
    reason              TEXT,
    evidence            TEXT,
    decision_json       TEXT NOT NULL CHECK(json_valid(decision_json)),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_balance_skill_decisions_check
    ON sim_balance_skill_decisions(check_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sim_balance_skill_jobs (
    id                  TEXT PRIMARY KEY,
    check_id            TEXT NOT NULL REFERENCES sim_balance_checks(id) ON DELETE CASCADE,
    response_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    step_index          INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'leased', 'completed', 'stopped')),
    lease_owner         TEXT,
    lease_expires_at    TIMESTAMP,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(check_id, response_message_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_balance_skill_jobs_claim
    ON sim_balance_skill_jobs(status, lease_expires_at, created_at);

UPDATE sim_balance_profiles
SET skill_config = '{"id":"readonly-balance-menu","version":"1","objective":"查询当前可用现金话费余额","confidence_threshold":0.85,"max_turns":4,"allowed_currencies":["CNY"],"forbidden_intents":["充值","缴费","订购","退订","办理","开通","购买","套餐变更","活动"]}',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'cn-mobile-sms-menu-v1';

-- Resume recent menu replies that arrived before the runner architecture was enabled.
INSERT OR IGNORE INTO sim_balance_skill_jobs (
    id, check_id, response_message_id, step_index
)
SELECT
    'skill-backfill-' || c.id,
    c.id,
    c.response_message_id,
    c.step_index
FROM sim_balance_checks c
JOIN sim_balance_profiles p ON p.id = c.profile_id
WHERE c.status IN ('response_received', 'unparsed')
  AND c.raw_response IS NOT NULL
  AND p.skill_config != '{}'
  AND datetime(c.requested_at) >= datetime('now', '-24 hours');
