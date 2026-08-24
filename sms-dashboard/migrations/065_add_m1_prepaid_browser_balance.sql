-- Generalize the local browser runner and add the first M1 prepaid portal profile.
-- The profile stays discovery-only until the controlled S73-S77 validation is complete.

PRAGMA defer_foreign_keys = ON;

ALTER TABLE balance_runner_capabilities RENAME TO balance_runner_capabilities_old;

CREATE TABLE balance_runner_capabilities (
    runner_id       TEXT NOT NULL
        REFERENCES balance_runner_installations(id) ON DELETE CASCADE,
    capability      TEXT NOT NULL CHECK(capability IN ('sms_ai', 'carrier_browser')),
    state           TEXT NOT NULL CHECK(state IN (
        'starting', 'ready', 'busy', 'degraded', 'configuration_required', 'stopping'
    )),
    session_id      TEXT NOT NULL,
    current_job_id  TEXT,
    concurrency     INTEGER NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 8),
    detail_code     TEXT,
    last_heartbeat  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (runner_id, capability)
);

INSERT INTO balance_runner_capabilities (
    runner_id, capability, state, session_id, current_job_id, concurrency,
    detail_code, last_heartbeat, updated_at
)
SELECT runner_id,
       CASE capability WHEN 'unicom_browser' THEN 'carrier_browser' ELSE capability END,
       state, session_id, current_job_id, concurrency, detail_code,
       last_heartbeat, updated_at
FROM balance_runner_capabilities_old;

DROP TABLE balance_runner_capabilities_old;

CREATE INDEX idx_balance_runner_capabilities_health
    ON balance_runner_capabilities(capability, last_heartbeat DESC);

ALTER TABLE sim_balance_web_events RENAME TO sim_balance_web_events_old;
ALTER TABLE sim_balance_web_jobs RENAME TO sim_balance_web_jobs_old;

CREATE TABLE sim_balance_web_jobs (
    id                  TEXT PRIMARY KEY,
    check_id            TEXT NOT NULL UNIQUE
        REFERENCES sim_balance_checks(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL CHECK(provider IN ('china_unicom', 'm1_prepaid')),
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

INSERT INTO sim_balance_web_jobs (
    id, check_id, provider, status, lease_owner, lease_expires_at,
    otp_requested_at, otp_message_id, human_reason, attempts, last_error,
    created_at, updated_at
)
SELECT id, check_id, provider, status, lease_owner, lease_expires_at,
       otp_requested_at, otp_message_id, human_reason, attempts, last_error,
       created_at, updated_at
FROM sim_balance_web_jobs_old;

CREATE TABLE sim_balance_web_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES sim_balance_web_jobs(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sim_balance_web_events (id, job_id, event_type, detail_json, created_at)
SELECT id, job_id, event_type, detail_json, created_at
FROM sim_balance_web_events_old;

DROP TABLE sim_balance_web_events_old;
DROP TABLE sim_balance_web_jobs_old;

CREATE INDEX idx_balance_web_jobs_claim
    ON sim_balance_web_jobs(status, lease_expires_at, created_at);
CREATE INDEX idx_balance_web_events_job
    ON sim_balance_web_events(job_id, created_at);

INSERT INTO sim_balance_profiles (
    id, country_code, carrier, method, command, destination,
    expected_senders, parser_version, response_window_minutes,
    discovery_enabled, enabled, conversation_steps, skill_config
) VALUES (
    'sg-m1-prepaid-browser-v1',
    'SG',
    'M1',
    'browser',
    'https://mcardaccount.m1.com.sg/login',
    NULL,
    '["M1 Limited"]',
    'sg-m1-prepaid-web-balance-v1',
    15,
    1,
    0,
    '[]',
    '{"id":"m1-prepaid-web-balance","version":"1","login_mode":"sms_otp","balance_url":"https://mcardaccount.m1.com.sg/balance","max_otp_requests":1,"human_verification_timeout_seconds":900,"cooldown_seconds":300,"required_service_type":"prepaid","outputs":["cash_balance","account_expiry"]}'
);
