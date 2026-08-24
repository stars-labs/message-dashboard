-- Account-level postpaid billing workflow. Bills are normalized from retained
-- carrier SMS evidence and are never copied into SIM balance tables.

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
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(country_code, carrier, account_ref_digest)
);

CREATE INDEX idx_carrier_billing_accounts_notification
    ON carrier_billing_accounts(notification_sim_iccid, status);

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

CREATE UNIQUE INDEX idx_carrier_billing_account_sims_active
    ON carrier_billing_account_sims(sim_iccid)
    WHERE removed_at IS NULL;

CREATE INDEX idx_carrier_billing_account_sims_account
    ON carrier_billing_account_sims(billing_account_id, removed_at, sim_iccid);

CREATE TABLE carrier_bills (
    id                  TEXT PRIMARY KEY,
    billing_account_id  TEXT NOT NULL
        REFERENCES carrier_billing_accounts(id) ON DELETE RESTRICT,
    source_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
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

CREATE INDEX idx_carrier_bills_queue
    ON carrier_bills(action_status, due_date, billing_account_id);
CREATE INDEX idx_carrier_bills_account
    ON carrier_bills(billing_account_id, due_date DESC);

CREATE TRIGGER carrier_bills_evidence_immutable
BEFORE UPDATE OF
    billing_account_id, amount_minor, currency, due_date, received_at, parser_version
ON carrier_bills
BEGIN
    SELECT RAISE(ABORT, 'carrier bill evidence is immutable');
END;

CREATE TABLE carrier_bill_events (
    id                  TEXT PRIMARY KEY,
    bill_id             TEXT NOT NULL REFERENCES carrier_bills(id) ON DELETE RESTRICT,
    event_type          TEXT NOT NULL CHECK(event_type IN (
        'detected', 'duplicate_detected', 'parse_conflict',
        'payment_planned', 'paid', 'waived', 'reopened'
    )),
    actor_type          TEXT NOT NULL CHECK(actor_type IN ('system', 'user')),
    actor_subject       TEXT,
    idempotency_key     TEXT,
    source_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(
        (actor_type = 'system' AND actor_subject IS NULL)
        OR (actor_type = 'user' AND length(trim(actor_subject)) > 0)
    ),
    CHECK(idempotency_key IS NULL OR length(trim(idempotency_key)) > 0)
);

CREATE INDEX idx_carrier_bill_events_bill
    ON carrier_bill_events(bill_id, created_at, id);
CREATE UNIQUE INDEX idx_carrier_bill_events_user_idempotency
    ON carrier_bill_events(actor_subject, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_carrier_bill_events_source_type
    ON carrier_bill_events(event_type, source_message_id)
    WHERE source_message_id IS NOT NULL;

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
