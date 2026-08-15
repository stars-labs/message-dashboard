-- China Unicom browser balance workflow. Authentication runs only in a local,
-- visible browser; D1 stores task state and the final normalized balance.

CREATE TABLE IF NOT EXISTS sim_balance_web_jobs (
    id                  TEXT PRIMARY KEY,
    check_id            TEXT NOT NULL UNIQUE
        REFERENCES sim_balance_checks(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL CHECK(provider IN ('china_unicom')),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
        'pending', 'leased', 'awaiting_otp', 'authenticating', 'querying',
        'human_verification_required', 'completed', 'failed', 'stopped'
    )),
    lease_owner         TEXT,
    lease_expires_at    TIMESTAMP,
    otp_requested_at    TIMESTAMP,
    otp_message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
    human_reason        TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_balance_web_jobs_claim
    ON sim_balance_web_jobs(status, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS sim_balance_web_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES sim_balance_web_jobs(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_balance_web_events_job
    ON sim_balance_web_events(job_id, created_at);

INSERT OR IGNORE INTO sim_balance_profiles (
    id, country_code, carrier, method, command, destination,
    expected_senders, parser_version, response_window_minutes,
    discovery_enabled, enabled, conversation_steps, skill_config
) VALUES (
    'cn-unicom-browser-random-password-v1',
    'CN',
    'China Unicom',
    'browser',
    'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/',
    NULL,
    '["10010"]',
    'cn-unicom-web-balance-v1',
    15,
    1,
    0,
    '[]',
    '{"id":"unicom-web-balance","version":"1","login_mode":"random_password","query_origin":"https://imgxx.client.10010.com","query_endpoint":"https://www.10010.com/mall/service/query/userinfoquery","max_otp_requests":1,"human_verification_timeout_seconds":900}'
);
