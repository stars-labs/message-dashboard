-- Migration 039: auditable, allowlisted SIM balance queries

CREATE TABLE IF NOT EXISTS sim_balance_profiles (
    id                      TEXT PRIMARY KEY,
    country_code            TEXT NOT NULL,
    carrier                 TEXT NOT NULL,
    method                  TEXT NOT NULL CHECK(method IN ('sms', 'ussd', 'api', 'browser')),
    command                 TEXT NOT NULL,
    destination             TEXT,
    expected_senders        TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(expected_senders)),
    parser_version          TEXT NOT NULL,
    response_window_minutes INTEGER NOT NULL DEFAULT 30
        CHECK(response_window_minutes BETWEEN 1 AND 120),
    discovery_enabled       INTEGER NOT NULL DEFAULT 0 CHECK(discovery_enabled IN (0, 1)),
    enabled                 INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(method != 'sms' OR destination IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sim_balance_checks (
    id                  TEXT PRIMARY KEY,
    sim_iccid           TEXT NOT NULL REFERENCES sims(iccid) ON DELETE RESTRICT,
    profile_id          TEXT NOT NULL REFERENCES sim_balance_profiles(id) ON DELETE RESTRICT,
    requested_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at             TIMESTAMP,
    completed_at        TIMESTAMP,
    status              TEXT NOT NULL CHECK(status IN (
        'queued', 'awaiting_response', 'response_received', 'parsed',
        'failed', 'timed_out', 'unparsed'
    )),
    outbound_message_id TEXT UNIQUE,
    response_message_id TEXT UNIQUE,
    response_sender     TEXT,
    raw_response        TEXT,
    error               TEXT,
    parser_version      TEXT NOT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sim_balance_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id    TEXT NOT NULL REFERENCES sim_balance_checks(id) ON DELETE CASCADE,
    metric_type TEXT NOT NULL CHECK(metric_type IN (
        'cash_balance', 'current_charges', 'arrears', 'account_expiry',
        'data_remaining', 'sms_remaining', 'voice_remaining'
    )),
    value       REAL,
    unit        TEXT,
    currency    TEXT,
    expires_at  TIMESTAMP,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(check_id, metric_type)
);

ALTER TABLE messages ADD COLUMN purpose TEXT NOT NULL DEFAULT 'user'
    CHECK(purpose IN ('user', 'balance_maintenance'));
ALTER TABLE messages ADD COLUMN balance_check_id TEXT
    REFERENCES sim_balance_checks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_balance_checks_sim_requested
    ON sim_balance_checks(sim_iccid, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_checks_active
    ON sim_balance_checks(sim_iccid, status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_checks_one_active_per_sim
    ON sim_balance_checks(sim_iccid)
    WHERE status IN ('queued', 'awaiting_response');
CREATE INDEX IF NOT EXISTS idx_balance_metrics_type
    ON sim_balance_metrics(metric_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_purpose_timestamp
    ON messages(purpose, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_balance_check
    ON messages(balance_check_id);

-- Discovery profile only: it can be triggered manually through the API-key
-- protected control endpoint, but is not eligible for scheduled fleet rollout.
INSERT OR IGNORE INTO sim_balance_profiles (
    id, country_code, carrier, method, command, destination,
    expected_senders, parser_version, response_window_minutes,
    discovery_enabled, enabled
) VALUES (
    'cn-mobile-sms-menu-v1', 'CN', 'China Mobile', 'sms', '10086', '10086',
    '["10086"]', 'cn-mobile-menu-v1', 30, 1, 0
);
