-- Local balance-runner identity and ephemeral capability health.
-- Existing scripts register as legacy_api_key clients; the desktop agent will use
-- a scoped Auth0 device token without changing this data model.
CREATE TABLE IF NOT EXISTS balance_runner_installations (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    auth_mode       TEXT NOT NULL CHECK(auth_mode IN ('legacy_api_key', 'auth0_device')),
    auth_subject    TEXT,
    platform        TEXT NOT NULL,
    version         TEXT NOT NULL,
    last_heartbeat  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at      TIMESTAMP,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS balance_runner_capabilities (
    runner_id       TEXT NOT NULL
        REFERENCES balance_runner_installations(id) ON DELETE CASCADE,
    capability      TEXT NOT NULL CHECK(capability IN ('sms_ai', 'unicom_browser')),
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

CREATE INDEX IF NOT EXISTS idx_balance_runner_installations_heartbeat
    ON balance_runner_installations(last_heartbeat DESC);
CREATE INDEX IF NOT EXISTS idx_balance_runner_capabilities_health
    ON balance_runner_capabilities(capability, last_heartbeat DESC);
