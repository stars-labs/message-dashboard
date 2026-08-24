-- Optimistic account configuration and append-only administration audit.

ALTER TABLE carrier_billing_accounts
    ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);

ALTER TABLE carrier_billing_accounts
    ADD COLUMN last_mutation_id TEXT;

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

CREATE INDEX idx_carrier_billing_account_events_account
    ON carrier_billing_account_events(billing_account_id, created_at, id);

CREATE UNIQUE INDEX idx_carrier_billing_account_events_user_idempotency
    ON carrier_billing_account_events(actor_subject, idempotency_key);

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
