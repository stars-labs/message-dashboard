-- Balance query batches (GRA-233): a batch row, sim_balance_checks.batch_id, and the
-- 'cancelled' check status for queries cancelled before they started.
--
-- A CHECK constraint changes only by rebuilding sim_balance_checks. Dropping a parent
-- table runs its children's ON DELETE actions even with foreign keys deferred, and D1
-- cannot turn foreign keys off, so every table that references sim_balance_checks,
-- directly or through messages, is rebuilt with it:
--   1. create each table as <name>_new, its references pointing at the other _new tables,
--      so dropping an old table reaches only old tables (a _new table that referenced an
--      old name would lose its rows or links to that table's ON DELETE action);
--   2. copy every row;
--   3. drop the old tables;
--   4. rename the _new tables back, which rewrites their references to the final names;
--   5. recreate the indexes and triggers the drops removed.
-- Before applying to production, record a Time Travel bookmark (docs/deployment.md).

PRAGMA defer_foreign_keys = ON;

CREATE TABLE sim_balance_batches (
    id                   TEXT PRIMARY KEY,
    requested_by_subject TEXT,
    cancelled_at         TIMESTAMP,
    cancelled_by         TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 1. The rebuilt tables, under temporary names.

CREATE TABLE sim_balance_checks_new (
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

CREATE TABLE messages_new (
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
    balance_check_id      TEXT REFERENCES sim_balance_checks_new(id) ON DELETE SET NULL,
    processing_session_id TEXT
);

CREATE TABLE message_tags_new (
    message_id     TEXT NOT NULL,
    keyword_tag_id INTEGER NOT NULL,
    matched_text   TEXT NOT NULL,
    position       INTEGER NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, keyword_tag_id, position),
    FOREIGN KEY (message_id) REFERENCES messages_new(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
);

CREATE TABLE sim_balance_metrics_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id    TEXT NOT NULL REFERENCES sim_balance_checks_new(id) ON DELETE CASCADE,
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

CREATE TABLE sim_balance_skill_decisions_new (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id            TEXT NOT NULL REFERENCES sim_balance_checks_new(id) ON DELETE CASCADE,
    response_message_id TEXT REFERENCES messages_new(id) ON DELETE SET NULL,
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

CREATE TABLE sim_balance_skill_jobs_new (
    id                  TEXT PRIMARY KEY,
    check_id            TEXT NOT NULL REFERENCES sim_balance_checks_new(id) ON DELETE CASCADE,
    response_message_id TEXT REFERENCES messages_new(id) ON DELETE SET NULL,
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

CREATE TABLE sim_balance_web_jobs_new (
    id                  TEXT PRIMARY KEY,
    check_id            TEXT NOT NULL UNIQUE
        REFERENCES sim_balance_checks_new(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL CHECK(provider IN ('china_unicom', 'm1_prepaid')),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
        'pending', 'leased', 'awaiting_otp', 'authenticating', 'querying',
        'human_verification_required', 'completed', 'failed', 'stopped'
    )),
    lease_owner         TEXT,
    lease_expires_at    TIMESTAMP,
    otp_requested_at    TIMESTAMP,
    otp_message_id      TEXT REFERENCES messages_new(id) ON DELETE SET NULL,
    human_reason        TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sim_balance_web_events_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES sim_balance_web_jobs_new(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE carrier_bills_new (
    id                  TEXT PRIMARY KEY,
    billing_account_id  TEXT NOT NULL
        REFERENCES carrier_billing_accounts(id) ON DELETE RESTRICT,
    source_message_id   TEXT REFERENCES messages_new(id) ON DELETE SET NULL,
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

CREATE TABLE carrier_bill_events_new (
    id                  TEXT PRIMARY KEY,
    bill_id             TEXT NOT NULL REFERENCES carrier_bills_new(id) ON DELETE RESTRICT,
    event_type          TEXT NOT NULL CHECK(event_type IN (
        'detected', 'duplicate_detected', 'parse_conflict',
        'payment_planned', 'paid', 'waived', 'reopened'
    )),
    actor_type          TEXT NOT NULL CHECK(actor_type IN ('system', 'user')),
    actor_subject       TEXT,
    idempotency_key     TEXT,
    source_message_id   TEXT REFERENCES messages_new(id) ON DELETE SET NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(
        (actor_type = 'system' AND actor_subject IS NULL)
        OR (actor_type = 'user' AND length(trim(actor_subject)) > 0)
    ),
    CHECK(idempotency_key IS NULL OR length(trim(idempotency_key)) > 0)
);

-- 2. Every row, parents first.

INSERT INTO sim_balance_checks_new (
    id, sim_iccid, profile_id, requested_at, sent_at, completed_at, status,
    outbound_message_id, response_message_id, response_sender, raw_response, error,
    parser_version, created_at, updated_at, step_index, requested_by_subject, deadline_at
)
SELECT id, sim_iccid, profile_id, requested_at, sent_at, completed_at, status,
    outbound_message_id, response_message_id, response_sender, raw_response, error,
    parser_version, created_at, updated_at, step_index, requested_by_subject, deadline_at
FROM sim_balance_checks;

INSERT INTO messages_new (
    id, phone_iccid, phone_number, content, timestamp, type, status, recipient,
    verification_code, created_at, updated_at, error_message, sms_id, filter_status,
    filter_rule_id, purpose, balance_check_id, processing_session_id
)
SELECT id, phone_iccid, phone_number, content, timestamp, type, status, recipient,
    verification_code, created_at, updated_at, error_message, sms_id, filter_status,
    filter_rule_id, purpose, balance_check_id, processing_session_id
FROM messages;

INSERT INTO message_tags_new (message_id, keyword_tag_id, matched_text, position, created_at)
SELECT message_id, keyword_tag_id, matched_text, position, created_at FROM message_tags;

INSERT INTO sim_balance_metrics_new (
    id, check_id, metric_type, value, unit, currency, expires_at, created_at
)
SELECT id, check_id, metric_type, value, unit, currency, expires_at, created_at
FROM sim_balance_metrics;

INSERT INTO sim_balance_skill_decisions_new (
    id, check_id, response_message_id, step_index, skill_id, skill_version, model, action,
    selected_option, confidence, reason, evidence, decision_json, created_at
)
SELECT id, check_id, response_message_id, step_index, skill_id, skill_version, model, action,
    selected_option, confidence, reason, evidence, decision_json, created_at
FROM sim_balance_skill_decisions;

INSERT INTO sim_balance_skill_jobs_new (
    id, check_id, response_message_id, step_index, status, lease_owner, lease_expires_at,
    attempts, last_error, created_at, updated_at
)
SELECT id, check_id, response_message_id, step_index, status, lease_owner, lease_expires_at,
    attempts, last_error, created_at, updated_at
FROM sim_balance_skill_jobs;

INSERT INTO sim_balance_web_jobs_new (
    id, check_id, provider, status, lease_owner, lease_expires_at, otp_requested_at,
    otp_message_id, human_reason, attempts, last_error, created_at, updated_at
)
SELECT id, check_id, provider, status, lease_owner, lease_expires_at, otp_requested_at,
    otp_message_id, human_reason, attempts, last_error, created_at, updated_at
FROM sim_balance_web_jobs;

INSERT INTO sim_balance_web_events_new (id, job_id, event_type, detail_json, created_at)
SELECT id, job_id, event_type, detail_json, created_at FROM sim_balance_web_events;

INSERT INTO carrier_bills_new (
    id, billing_account_id, source_message_id, amount_minor, currency, due_date, received_at,
    parser_version, action_status, payment_planned_at, paid_at, paid_by, operator_note,
    version, created_at, updated_at
)
SELECT id, billing_account_id, source_message_id, amount_minor, currency, due_date, received_at,
    parser_version, action_status, payment_planned_at, paid_at, paid_by, operator_note,
    version, created_at, updated_at
FROM carrier_bills;

INSERT INTO carrier_bill_events_new (
    id, bill_id, event_type, actor_type, actor_subject, idempotency_key, source_message_id,
    metadata_json, created_at
)
SELECT id, bill_id, event_type, actor_type, actor_subject, idempotency_key, source_message_id,
    metadata_json, created_at
FROM carrier_bill_events;

-- 3. The old tables, children first.

DROP TABLE message_tags;
DROP TABLE sim_balance_web_events;
DROP TABLE carrier_bill_events;
DROP TABLE carrier_bills;
DROP TABLE sim_balance_metrics;
DROP TABLE sim_balance_skill_decisions;
DROP TABLE sim_balance_skill_jobs;
DROP TABLE sim_balance_web_jobs;
DROP TABLE messages;
DROP TABLE sim_balance_checks;

-- 4. The final names.

ALTER TABLE sim_balance_checks_new RENAME TO sim_balance_checks;
ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE message_tags_new RENAME TO message_tags;
ALTER TABLE sim_balance_metrics_new RENAME TO sim_balance_metrics;
ALTER TABLE sim_balance_skill_decisions_new RENAME TO sim_balance_skill_decisions;
ALTER TABLE sim_balance_skill_jobs_new RENAME TO sim_balance_skill_jobs;
ALTER TABLE sim_balance_web_jobs_new RENAME TO sim_balance_web_jobs;
ALTER TABLE sim_balance_web_events_new RENAME TO sim_balance_web_events;
ALTER TABLE carrier_bills_new RENAME TO carrier_bills;
ALTER TABLE carrier_bill_events_new RENAME TO carrier_bill_events;

-- 5. Indexes and triggers, as production had them, plus the batch index.

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
