-- The production schema. Generated, do not edit:
--   wrangler d1 export sms-dashboard --remote --no-data --output migrations/schema.sql
-- then restore this header. Regenerate after applying a migration to production,
-- and set `through` to that migration's number.
-- through: 085
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    user_email TEXT,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE keyword_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT DEFAULT '#3B82F6', -- Default blue color
    priority INTEGER DEFAULT 0, -- Higher priority keywords take precedence
    is_active BOOLEAN DEFAULT TRUE,
    case_sensitive BOOLEAN DEFAULT FALSE,
    whole_word BOOLEAN DEFAULT FALSE, -- Match whole words only
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE daemon_health (
          daemon_id TEXT PRIMARY KEY,
          last_heartbeat TIMESTAMP NOT NULL,
          status TEXT DEFAULT 'online',
          last_ip TEXT,
          version TEXT,
          modem_count INTEGER DEFAULT 0,
          error_count INTEGER DEFAULT 0,
          last_error TEXT,
          metadata TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        , current_session_id TEXT, last_full_sync TIMESTAMP, sync_mode TEXT DEFAULT 'incremental');
CREATE TABLE modems (
    equipment_id TEXT PRIMARY KEY,        -- IMEI from mmcli (e.g., "865827078383361")
    manufacturer TEXT,                    -- e.g., "QUALCOMM INCORPORATED"
    model TEXT,                           -- e.g., "QUECTEL Mobile Broadband Module"
    firmware_revision TEXT,               -- e.g., "EC20CEHDLGR08A02M1G"
    hardware_revision TEXT,               -- e.g., "10000"
    device_path TEXT,                     -- e.g., "/org/freedesktop/ModemManager1/Modem/66"
    usb_port INTEGER,                     -- Physical USB port number
    modem_index INTEGER,                  -- mmcli modem index (transient)
    status TEXT DEFAULT 'disconnected',  -- connected, disconnected, error
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, verification_status TEXT DEFAULT 'unverified', last_verified_session TEXT, detected_phone_number TEXT, operator TEXT, sim_read_status TEXT DEFAULT NULL, detected_iccid TEXT, detected_operator TEXT, signal_percent INTEGER, rssi INTEGER, usb_path TEXT, last_usb_path TEXT);
CREATE TABLE modem_sim_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modem_id TEXT NOT NULL,
    sim_iccid TEXT NOT NULL,
    inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP,
    signal_quality INTEGER,              -- Last known signal quality
    network_type TEXT,                   -- Last known network type (GSM, LTE, etc.)
    access_tech TEXT,                    -- Last known access technology
    FOREIGN KEY (modem_id) REFERENCES modems(equipment_id) ON DELETE CASCADE,
    FOREIGN KEY (sim_iccid) REFERENCES sims(iccid) ON DELETE CASCADE
);
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);
CREATE TABLE filter_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type  TEXT NOT NULL CHECK(rule_type IN ('body_keyword', 'sender')),
    pattern    TEXT NOT NULL,
    note       TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1,
    -- Auth0 subject of whoever added the rule. Deliberately NOT a foreign key:
    -- there is no `users` table in this database (keyword_tags declares such an FK
    -- and it is unsatisfiable — inserting into it fails with "no such table: users").
    -- This is provenance metadata we never join on, so a constraint would only add
    -- a failure mode.
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rule_type, pattern)
);
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE sim_balance_profiles (
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
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, conversation_steps TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(conversation_steps)), skill_config TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(skill_config)),
    CHECK(method != 'sms' OR destination IS NOT NULL)
);
CREATE TABLE balance_runner_installations (
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
CREATE TABLE IF NOT EXISTS "sims" (
  iccid TEXT PRIMARY KEY,
  sim_index INTEGER NOT NULL,
  phone_number TEXT NOT NULL,
  country_code TEXT,
  carrier TEXT,
  imei TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  service_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK(service_type IN ('unknown', 'prepaid', 'postpaid', 'balance_managed')),
  service_type_source TEXT
    CHECK(service_type_source IS NULL OR service_type_source IN (
      'carrier_account', 'carrier_support', 'contract_or_bill', 'carrier_message'
    )),
  service_type_verified_at TIMESTAMP,
  sim_role TEXT NOT NULL DEFAULT 'standalone'
    CHECK(sim_role IN ('standalone', 'primary', 'secondary')),
  primary_iccid TEXT
    REFERENCES sims(iccid) ON DELETE RESTRICT,
  balance_threshold REAL
);
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
CREATE TABLE carrier_billing_accounts (
    id                      TEXT PRIMARY KEY,
    country_code            TEXT NOT NULL
        CHECK(length(country_code) = 2 AND country_code = upper(country_code)),
    carrier                 TEXT NOT NULL CHECK(length(trim(carrier)) > 0),
    currency                TEXT NOT NULL
        CHECK(length(currency) = 3 AND currency = upper(currency)),
    display_name            TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
    notification_sim_iccid  TEXT NOT NULL
        REFERENCES sims(iccid) ON DELETE RESTRICT,
    account_ref_digest      TEXT NOT NULL
        CHECK(length(account_ref_digest) = 64
          AND account_ref_digest NOT GLOB '*[^0-9a-f]*'),
    account_ref_last4       TEXT NOT NULL CHECK(length(account_ref_last4) = 4),
    status                  TEXT NOT NULL DEFAULT 'pending_verification'
        CHECK(status IN ('pending_verification', 'active', 'inactive')),
    created_by              TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1), last_mutation_id TEXT,
    UNIQUE(country_code, carrier, account_ref_digest)
);
CREATE TABLE carrier_billing_account_sims (
    billing_account_id  TEXT NOT NULL
        REFERENCES carrier_billing_accounts(id) ON DELETE RESTRICT,
    sim_iccid            TEXT NOT NULL REFERENCES sims(iccid) ON DELETE RESTRICT,
    verification_source  TEXT NOT NULL CHECK(verification_source IN (
        'carrier_account', 'contract_or_bill', 'carrier_support'
    )),
    verified_at          TIMESTAMP NOT NULL,
    verified_by          TEXT NOT NULL CHECK(length(trim(verified_by)) > 0),
    removed_at           TIMESTAMP,
    PRIMARY KEY (billing_account_id, sim_iccid),
    CHECK(removed_at IS NULL OR removed_at >= verified_at)
);
CREATE TABLE carrier_billing_account_events (
    id                  TEXT PRIMARY KEY,
    billing_account_id  TEXT NOT NULL
        REFERENCES carrier_billing_accounts(id) ON DELETE RESTRICT,
    event_type          TEXT NOT NULL CHECK(event_type IN (
        'created', 'updated', 'members_changed', 'backfill_executed'
    )),
    actor_subject       TEXT NOT NULL CHECK(length(trim(actor_subject)) > 0),
    idempotency_key     TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
    metadata_json       TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ANALYZE sqlite_schema;
CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    iccid TEXT NOT NULL,
    remote_number TEXT,
    outcome TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(outcome IN ('in_progress', 'answered', 'missed', 'rejected', 'cancelled', 'failed')),
    end_reason TEXT,
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    -- Talk time only: ended_at - answered_at. A call that never connected is 0.
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    requested_by TEXT,
    answered_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE alert_state (
  alert TEXT PRIMARY KEY CHECK (alert = 'daemon_offline'),
  first_seen_at TEXT NOT NULL,
  notified_at TEXT
);
CREATE TABLE sim_balance_batches (
    id                   TEXT PRIMARY KEY,
    requested_by_subject TEXT,
    cancelled_at         TIMESTAMP,
    cancelled_by         TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "sim_balance_checks" (
    id                  TEXT PRIMARY KEY,
    sim_iccid           TEXT NOT NULL REFERENCES sims(iccid) ON DELETE RESTRICT,
    profile_id          TEXT NOT NULL REFERENCES sim_balance_profiles(id) ON DELETE RESTRICT,
    requested_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at             TIMESTAMP,
    completed_at        TIMESTAMP,
    status              TEXT NOT NULL CHECK(status IN (
        'queued', 'awaiting_response', 'response_received', 'parsed',
        'failed', 'timed_out', 'unparsed', 'cancelled'
    )),
    outbound_message_id TEXT UNIQUE,
    response_message_id TEXT UNIQUE,
    response_sender     TEXT,
    raw_response        TEXT,
    error               TEXT,
    parser_version      TEXT NOT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    step_index          INTEGER NOT NULL DEFAULT 0 CHECK(step_index >= 0),
    requested_by_subject TEXT,
    deadline_at         TIMESTAMP,
    batch_id            TEXT REFERENCES sim_balance_batches(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS "messages" (
    id                    TEXT PRIMARY KEY,
    phone_iccid           TEXT,
    phone_number          TEXT,
    content               TEXT NOT NULL,
    timestamp             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    type                  TEXT CHECK(type IN ('sent', 'received')),
    status                TEXT,
    recipient             TEXT,
    verification_code     TEXT,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_message         TEXT,
    sms_id                TEXT,
    filter_status         TEXT NOT NULL DEFAULT 'pending',
    filter_rule_id        INTEGER REFERENCES filter_rules(id) ON DELETE SET NULL,
    purpose               TEXT NOT NULL DEFAULT 'user'
        CHECK(purpose IN ('user', 'balance_maintenance')),
    balance_check_id      TEXT REFERENCES "sim_balance_checks"(id) ON DELETE SET NULL,
    processing_session_id TEXT
);
CREATE TABLE IF NOT EXISTS "message_tags" (
    message_id     TEXT NOT NULL,
    keyword_tag_id INTEGER NOT NULL,
    matched_text   TEXT NOT NULL,
    position       INTEGER NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, keyword_tag_id, position),
    FOREIGN KEY (message_id) REFERENCES "messages"(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "sim_balance_metrics" (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id    TEXT NOT NULL REFERENCES "sim_balance_checks"(id) ON DELETE CASCADE,
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
CREATE TABLE IF NOT EXISTS "sim_balance_skill_decisions" (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id            TEXT NOT NULL REFERENCES "sim_balance_checks"(id) ON DELETE CASCADE,
    response_message_id TEXT REFERENCES "messages"(id) ON DELETE SET NULL,
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
CREATE TABLE IF NOT EXISTS "sim_balance_skill_jobs" (
    id                  TEXT PRIMARY KEY,
    check_id            TEXT NOT NULL REFERENCES "sim_balance_checks"(id) ON DELETE CASCADE,
    response_message_id TEXT REFERENCES "messages"(id) ON DELETE SET NULL,
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
CREATE TABLE IF NOT EXISTS "sim_balance_web_jobs" (
    id                  TEXT PRIMARY KEY,
    check_id            TEXT NOT NULL UNIQUE
        REFERENCES "sim_balance_checks"(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL CHECK(provider IN ('china_unicom', 'm1_prepaid')),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
        'pending', 'leased', 'awaiting_otp', 'authenticating', 'querying',
        'human_verification_required', 'completed', 'failed', 'stopped'
    )),
    lease_owner         TEXT,
    lease_expires_at    TIMESTAMP,
    otp_requested_at    TIMESTAMP,
    otp_message_id      TEXT REFERENCES "messages"(id) ON DELETE SET NULL,
    human_reason        TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "sim_balance_web_events" (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES "sim_balance_web_jobs"(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "carrier_bills" (
    id                  TEXT PRIMARY KEY,
    billing_account_id  TEXT NOT NULL
        REFERENCES carrier_billing_accounts(id) ON DELETE RESTRICT,
    source_message_id   TEXT REFERENCES "messages"(id) ON DELETE SET NULL,
    amount_minor        INTEGER NOT NULL
        CHECK(typeof(amount_minor) = 'integer' AND amount_minor >= 0),
    currency            TEXT NOT NULL
        CHECK(length(currency) = 3 AND currency = upper(currency)),
    due_date            TEXT NOT NULL CHECK(
        due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(due_date, '+0 days') = due_date
    ),
    received_at         TIMESTAMP NOT NULL,
    parser_version      TEXT NOT NULL CHECK(length(trim(parser_version)) > 0),
    action_status       TEXT NOT NULL DEFAULT 'unpaid' CHECK(action_status IN (
        'unpaid', 'payment_planned', 'paid', 'waived', 'needs_review'
    )),
    payment_planned_at  TIMESTAMP,
    paid_at             TIMESTAMP,
    paid_by             TEXT,
    operator_note       TEXT,
    version             INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_message_id),
    UNIQUE(billing_account_id, due_date),
    CHECK(action_status != 'payment_planned' OR payment_planned_at IS NOT NULL),
    CHECK(action_status != 'paid' OR (paid_at IS NOT NULL AND paid_by IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS "carrier_bill_events" (
    id                  TEXT PRIMARY KEY,
    bill_id             TEXT NOT NULL REFERENCES "carrier_bills"(id) ON DELETE RESTRICT,
    event_type          TEXT NOT NULL CHECK(event_type IN (
        'detected', 'duplicate_detected', 'parse_conflict',
        'payment_planned', 'paid', 'waived', 'reopened'
    )),
    actor_type          TEXT NOT NULL CHECK(actor_type IN ('system', 'user')),
    actor_subject       TEXT,
    idempotency_key     TEXT,
    source_message_id   TEXT REFERENCES "messages"(id) ON DELETE SET NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(
        (actor_type = 'system' AND actor_subject IS NULL)
        OR (actor_type = 'user' AND length(trim(actor_subject)) > 0)
    ),
    CHECK(idempotency_key IS NULL OR length(trim(idempotency_key)) > 0)
);
DELETE FROM sqlite_sequence;
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_user_email ON audit_logs(user_email);
CREATE INDEX idx_keyword_tags_keyword ON keyword_tags(keyword);
CREATE INDEX idx_keyword_tags_active ON keyword_tags(is_active);
CREATE INDEX idx_keyword_tags_priority ON keyword_tags(priority DESC);
CREATE INDEX idx_modems_status ON modems(status);
CREATE INDEX idx_modems_usb_port ON modems(usb_port);
CREATE INDEX idx_modem_sim_history_dates ON modem_sim_history(inserted_at, removed_at);
CREATE INDEX idx_modems_modem_index ON modems(modem_index);
CREATE INDEX idx_filter_rules_active      ON filter_rules(is_active);
CREATE INDEX idx_balance_runner_installations_heartbeat
    ON balance_runner_installations(last_heartbeat DESC);
CREATE INDEX idx_sims_sim_index ON sims(sim_index);
CREATE UNIQUE INDEX idx_sims_imei_unique ON sims(imei) WHERE imei IS NOT NULL;
CREATE INDEX idx_balance_runner_capabilities_health
    ON balance_runner_capabilities(capability, last_heartbeat DESC);
CREATE INDEX idx_carrier_billing_accounts_notification
    ON carrier_billing_accounts(notification_sim_iccid, status);
CREATE UNIQUE INDEX idx_carrier_billing_account_sims_active
    ON carrier_billing_account_sims(sim_iccid)
    WHERE removed_at IS NULL;
CREATE INDEX idx_carrier_billing_account_sims_account
    ON carrier_billing_account_sims(billing_account_id, removed_at, sim_iccid);
CREATE INDEX idx_carrier_billing_account_events_account
    ON carrier_billing_account_events(billing_account_id, created_at, id);
CREATE UNIQUE INDEX idx_carrier_billing_account_events_user_idempotency
    ON carrier_billing_account_events(actor_subject, idempotency_key);
CREATE UNIQUE INDEX idx_carrier_billing_accounts_active_notification_sim
    ON carrier_billing_accounts(notification_sim_iccid)
    WHERE status = 'active';
CREATE INDEX idx_calls_started_at ON calls(started_at DESC);
CREATE INDEX idx_calls_iccid_started_at ON calls(iccid, started_at DESC);
CREATE UNIQUE INDEX idx_calls_open_ring
    ON calls(iccid)
 WHERE outcome = 'in_progress' AND direction = 'inbound' AND answered_at IS NULL;
CREATE INDEX idx_messages_normalized_phone_iccid ON "messages"(phone_iccid);
CREATE INDEX idx_messages_normalized_timestamp ON "messages"(timestamp);
CREATE INDEX idx_messages_normalized_type ON "messages"(type);
CREATE INDEX idx_messages_normalized_timestamp_type ON "messages"(timestamp, type);
CREATE INDEX idx_messages_normalized_verification ON "messages"(verification_code) WHERE verification_code IS NOT NULL;
CREATE INDEX idx_messages_filter_ts       ON messages(filter_status, timestamp DESC);
CREATE INDEX idx_messages_iccid_filter_ts ON messages(phone_iccid, filter_status, timestamp DESC);
CREATE INDEX idx_messages_filter_rule_id  ON messages(filter_rule_id);
CREATE INDEX idx_message_tags_message_id     ON message_tags(message_id);
CREATE INDEX idx_message_tags_keyword_tag_id ON message_tags(keyword_tag_id);
CREATE INDEX idx_message_tags_message ON message_tags(message_id);
CREATE INDEX idx_message_tags_keyword ON message_tags(keyword_tag_id);
CREATE INDEX idx_balance_checks_sim_requested
    ON sim_balance_checks(sim_iccid, requested_at DESC);
CREATE INDEX idx_balance_checks_active
    ON sim_balance_checks(sim_iccid, status, requested_at DESC);
CREATE UNIQUE INDEX idx_balance_checks_one_active_per_sim
    ON sim_balance_checks(sim_iccid)
    WHERE status IN ('queued', 'awaiting_response');
CREATE INDEX idx_balance_metrics_type
    ON sim_balance_metrics(metric_type, created_at DESC);
CREATE INDEX idx_messages_purpose_timestamp
    ON messages(purpose, timestamp DESC);
CREATE INDEX idx_messages_balance_check
    ON messages(balance_check_id);
CREATE INDEX idx_balance_skill_decisions_check
    ON sim_balance_skill_decisions(check_id, created_at DESC);
CREATE INDEX idx_balance_skill_jobs_claim
    ON sim_balance_skill_jobs(status, lease_expires_at, created_at);
CREATE INDEX idx_balance_checks_owner_status
    ON sim_balance_checks(requested_by_subject, status, requested_at DESC);
CREATE INDEX idx_balance_web_jobs_claim
    ON sim_balance_web_jobs(status, lease_expires_at, created_at);
CREATE INDEX idx_balance_web_events_job
    ON sim_balance_web_events(job_id, created_at);
CREATE INDEX idx_carrier_bills_queue
    ON carrier_bills(action_status, due_date, billing_account_id);
CREATE INDEX idx_carrier_bills_account
    ON carrier_bills(billing_account_id, due_date DESC);
CREATE INDEX idx_carrier_bill_events_bill
    ON carrier_bill_events(bill_id, created_at, id);
CREATE UNIQUE INDEX idx_carrier_bill_events_user_idempotency
    ON carrier_bill_events(actor_subject, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_carrier_bill_events_source_type
    ON carrier_bill_events(event_type, source_message_id)
    WHERE source_message_id IS NOT NULL;
CREATE INDEX idx_messages_pending_outbound
ON messages(purpose, created_at, id)
WHERE type = 'sent' AND status = 'sending';
CREATE INDEX idx_messages_processing_outbound
ON messages(processing_session_id, updated_at)
WHERE type = 'sent' AND status = 'processing';
CREATE INDEX idx_balance_checks_requested
ON sim_balance_checks(requested_at DESC);
CREATE INDEX idx_messages_user_created
ON messages(purpose, created_at DESC, id DESC);
CREATE INDEX idx_messages_iccid_user_created
ON messages(phone_iccid, purpose, created_at DESC, id DESC);
CREATE INDEX idx_messages_otp_cursor
ON messages(phone_iccid, created_at, id)
WHERE type = 'received' AND verification_code IS NOT NULL;
CREATE INDEX idx_balance_checks_status_deadline
ON sim_balance_checks(status, deadline_at);
CREATE INDEX idx_balance_web_jobs_pending_claim
ON sim_balance_web_jobs(created_at, id)
WHERE status = 'pending' AND attempts < 3;
CREATE INDEX idx_messages_outbound_updated
    ON messages(type, updated_at);
CREATE INDEX idx_balance_checks_batch
    ON sim_balance_checks(batch_id) WHERE batch_id IS NOT NULL;
CREATE TRIGGER validate_sim_service_type_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.service_type IN ('unknown', 'balance_managed')
    AND NEW.service_type_source IS NULL
    AND NEW.service_type_verified_at IS NULL)
  OR
  (NEW.service_type IN ('prepaid', 'postpaid')
    AND NEW.service_type_source IS NOT NULL
    AND NEW.service_type_verified_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid SIM service type verification metadata');
END;
CREATE TRIGGER validate_sim_service_type_update
BEFORE UPDATE OF service_type, service_type_source, service_type_verified_at ON sims
WHEN NOT (
  (NEW.service_type IN ('unknown', 'balance_managed')
    AND NEW.service_type_source IS NULL
    AND NEW.service_type_verified_at IS NULL)
  OR
  (NEW.service_type IN ('prepaid', 'postpaid')
    AND NEW.service_type_source IS NOT NULL
    AND NEW.service_type_verified_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid SIM service type verification metadata');
END;
CREATE TRIGGER validate_sim_role_insert
BEFORE INSERT ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary' AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;
CREATE TRIGGER validate_sim_role_update
BEFORE UPDATE OF sim_role, primary_iccid ON sims
WHEN NOT (
  (NEW.sim_role = 'standalone' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'primary' AND NEW.primary_iccid IS NULL)
  OR
  (NEW.sim_role = 'secondary' AND NEW.primary_iccid IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'secondary SIM requires primary_iccid; primary/standalone must not set it');
END;
CREATE TRIGGER carrier_billing_account_events_immutable_update
BEFORE UPDATE ON carrier_billing_account_events
BEGIN
    SELECT RAISE(ABORT, 'carrier billing account events are immutable');
END;
CREATE TRIGGER carrier_billing_account_events_immutable_delete
BEFORE DELETE ON carrier_billing_account_events
BEGIN
    SELECT RAISE(ABORT, 'carrier billing account events are immutable');
END;
CREATE TRIGGER carrier_bills_evidence_immutable
BEFORE UPDATE OF
    billing_account_id, amount_minor, currency, due_date, received_at, parser_version
ON carrier_bills
BEGIN
    SELECT RAISE(ABORT, 'carrier bill evidence is immutable');
END;
CREATE TRIGGER carrier_bill_events_immutable_update
BEFORE UPDATE ON carrier_bill_events
WHEN NOT (
    OLD.source_message_id IS NOT NULL
    AND NEW.source_message_id IS NULL
    AND NEW.id IS OLD.id
    AND NEW.bill_id IS OLD.bill_id
    AND NEW.event_type IS OLD.event_type
    AND NEW.actor_type IS OLD.actor_type
    AND NEW.actor_subject IS OLD.actor_subject
    AND NEW.idempotency_key IS OLD.idempotency_key
    AND NEW.metadata_json IS OLD.metadata_json
    AND NEW.created_at IS OLD.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'carrier bill events are immutable');
END;
CREATE TRIGGER carrier_bill_events_immutable_delete
BEFORE DELETE ON carrier_bill_events
BEGIN
    SELECT RAISE(ABORT, 'carrier bill events are immutable');
END;
CREATE TRIGGER require_outbound_queue_fields_on_insert
BEFORE INSERT ON messages
WHEN NEW.type = 'sent' AND NEW.status = 'sending'
  AND (NEW.recipient IS NULL OR NEW.phone_iccid IS NULL OR NEW.created_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued outbound SMS requires recipient, phone_iccid, and created_at');
END;
CREATE TRIGGER require_outbound_queue_fields_on_update
BEFORE UPDATE OF type, status, recipient, phone_iccid, created_at ON messages
WHEN NEW.type = 'sent' AND NEW.status = 'sending'
  AND (NEW.recipient IS NULL OR NEW.phone_iccid IS NULL OR NEW.created_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued outbound SMS requires recipient, phone_iccid, and created_at');
END;
CREATE VIEW device_view AS
SELECT
  s.iccid as id,
  m.equipment_id,
  m.manufacturer,
  m.model,
  m.usb_port as primary_port,
  m.usb_path,
  m.last_usb_path,
  m.status as modem_status,
  s.iccid,
  s.phone_number as number,
  s.carrier,
  s.country_code as country,
  s.sim_index,
  s.notes,
  s.service_type,
  s.service_type_source,
  s.service_type_verified_at,
  s.sim_role,
  s.primary_iccid,
  s.balance_threshold,
  m.detected_operator as operator,
  CASE
    WHEN s.imei IS NULL THEN 'unassigned'
    WHEN m.equipment_id IS NULL THEN 'no_modem'
    WHEN m.status = 'disconnected' THEN 'offline'
    WHEN m.detected_iccid IS NULL THEN 'sim_error'
    WHEN m.detected_iccid = s.iccid THEN 'active'
    ELSE 'iccid_mismatch'
  END as sim_status,
  m.signal_percent as signal_quality,
  m.detected_iccid,
  m.detected_phone_number,
  s.imei,
  s.created_at,
  s.updated_at
FROM sims s
LEFT JOIN modems m ON s.imei = m.equipment_id
ORDER BY s.sim_index ASC;
