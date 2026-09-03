# Reliable Message Outbox Plan

## Status

Plan created on 2026-09-03. No implementation or production recovery is
authorized by this document. Production message requeueing, D1 mutation, daemon
deployment, and Worker deployment each require their normal explicit approval.

Current production health evidence at plan creation:

- Daemon heartbeat current and modem reading healthy.
- Message uploader last succeeded about eight minutes earlier.
- 96 local messages had exhausted their retry limit.
- 3 local messages were stuck in `uploading`.
- No messages were still eligible for the current automatic retry loop.

## Problem

The browser's `(created_at, id)` ingestion cursor is now bounded and independent
of daemon health, but the local-to-cloud delivery path is not a reliable outbox.
The daemon currently:

- deletes `pending` local messages after one hour;
- selects only messages with fewer than five upload attempts;
- can strand a batch in `uploading` if it exits after claiming the batch;
- does not send a stable locally assigned message ID to Cloudflare; and
- uses content and a ten-second timestamp window for duplicate detection.

Consequently, monitoring can detect a stalled uploader but cannot recover it.
A delayed upload will still be found by the dashboard because D1 assigns
`created_at` when the delayed message is finally inserted. The missing guarantee
is that every locally persisted message eventually reaches that insert.

## Objective

Provide at-least-once delivery from the Orange Pi with an exactly-once effect in
D1:

```text
modem
  -> durable local SQLite row
  -> leased, indefinitely retryable outbox delivery
  -> idempotent D1 insert using the same stable ID
  -> dashboard (created_at, id) cursor
```

Heartbeat remains an observer of this pipeline. It does not advance a cursor,
trigger a message upload, or trigger device reconciliation.

## Scope

### In scope

- Orange Pi local message schema and upload state machine.
- Stable message identity from local persistence through D1.
- Worker message-ingestion idempotency and acknowledgement contract.
- Removal of time-based deletion for unacknowledged local messages.
- Automatic recovery of abandoned uploads.
- A smaller versioned heartbeat contract based on pipeline progress and queue
  age.
- One-time reconciliation and recovery of the existing exhausted and stuck
  records after the new idempotency boundary is deployed.

### Out of scope

- Redesigning the dashboard message cursor.
- Changing the D1 message-retention policy.
- Changing physical `ME`/`SM` deletion safety. Local SQLite remains the durable
  boundary before deleting an SMS from modem storage; see
  [`sms-hardware-storage-safety-plan.md`](sms-hardware-storage-safety-plan.md).
- Sending production SMS or querying carrier balances.
- Keeping legacy upload or heartbeat contracts after the coordinated cutover.

## Invariants

1. A message not acknowledged by Cloudflare is never deleted by age.
2. A message receives one stable ID when first persisted locally; retries and
   restarts never change it.
3. D1 uses that same ID as `messages.id`; there is no second cloud identity.
4. Repeating an upload has the same D1 effect as uploading it once.
5. A daemon exit at any point leaves the message either acknowledged or
   automatically eligible for retry after a bounded lease.
6. Transient failures retry indefinitely with capped backoff.
7. Permanent input rejection is explicit and operator-visible; it is never
   silently treated as uploaded.
8. The persisted message payload is the payload uploaded to Cloudflare. Retry
   logic does not reconstruct or reinterpret message content.
9. The dashboard cursor advances only after every page in its frozen D1
   ingestion window succeeds.
10. Heartbeat state cannot mutate message-delivery or device-sync state.

## Target Data Model

Keep the local integer primary key for efficient SQLite access. Add a canonical
cross-system ID and explicit delivery fields:

```text
source_message_id  TEXT UNIQUE NOT NULL
status             TEXT NOT NULL
attempts           INTEGER NOT NULL DEFAULT 0
next_attempt_at    TIMESTAMP
lease_token        TEXT
lease_expires_at   TIMESTAMP
uploaded_at        TIMESTAMP
last_error         TEXT
```

Allowed states:

```text
pending -> in_flight -> uploaded
                    \-> pending       transient failure or expired lease
                    \-> dead_letter   permanent per-message rejection
```

The JSON upload field is `id`; it carries the local `source_message_id`. The
Worker stores it directly as D1 `messages.id`. Do not add a duplicate
`source_message_id` column to D1.

Existing local rows receive a UUID exactly once in an idempotent transactional
SQLite migration. New rows receive a UUID in the same transaction that stores
their modem payload.

## Worker Ingestion Contract

Replace fuzzy duplicate detection with primary-key idempotency:

```sql
INSERT INTO messages (id, ...)
VALUES (?, ...)
ON CONFLICT(id) DO NOTHING;
```

Requirements:

- `id` is mandatory and validated before processing.
- `stored` and `already_stored` both acknowledge durable ownership of the ID.
- Two messages with identical ICCID, content, and timestamp but different IDs
  are both preserved.
- Only newly inserted rows run keyword, filter, balance-correlation, and billing
  side effects.
- The response contains one result per submitted ID:

```json
{
  "results": [
    { "id": "...", "status": "stored" },
    { "id": "...", "status": "already_stored" },
    { "id": "...", "status": "rejected", "retryable": false }
  ]
}
```

- A whole-request infrastructure failure returns a non-success response and
  acknowledges no additional local rows. Any rows committed before a lost
  response are safe because retrying their IDs is idempotent.
- Remove the runtime fallback that generates IDs in the Worker and remove the
  ICCID/content/time-window duplicate query after cutover.

## Daemon Outbox Behavior

### Claim

In one local SQLite transaction:

1. Select eligible `pending` rows whose `next_attempt_at` is due, plus
   `in_flight` rows whose lease expired.
2. Assign one batch lease token and a lease expiry longer than the HTTP timeout.
3. Change those rows to `in_flight` and increment `attempts`.
4. Return the claimed rows with their stable IDs.

No second uploader can claim an unexpired lease.

### Acknowledge

- `stored` or `already_stored`: mark that ID `uploaded` and clear its lease.
- Permanent per-message rejection: mark that ID `dead_letter`, retain its full
  local payload, and expose the reason.
- Timeout, network failure, rate limit, D1 quota, or server failure: return each
  claimed row to `pending`, clear its lease, store the error, and schedule the
  next attempt.

### Retry

Use exponential backoff with jitter and a five-minute cap. `attempts` remains a
diagnostic counter and never makes a transiently failing row ineligible.

### Recovery

An expired `in_flight` lease is eligible in the normal claim transaction. No
special startup reset is required, and a process exit at any instruction cannot
strand a row permanently.

### Cleanup

- Delete no `pending`, `in_flight`, or `dead_letter` row based on age.
- Remove `cleanup_all_old_pending()` and both callers.
- Remove its unrelated `sim_storage` reset.
- Retain only an explicit uploaded-row retention job.

## Heartbeat Contract

Send one heartbeat every 60 seconds:

```json
{
  "schema_version": 3,
  "session_id": "rust-daemon-...",
  "version": "...",
  "uptime_seconds": 123,
  "last_message_read_success_age_seconds": 2,
  "last_upload_success_age_seconds": 8,
  "queue": {
    "pending": 3,
    "in_flight": 1,
    "dead_letter": 0,
    "oldest_unacknowledged_age_seconds": 45
  }
}
```

Health derivation:

- No heartbeat for more than three minutes: `offline`.
- Empty queue: an idle uploader is healthy regardless of the age of its last
  successful upload.
- Non-empty queue with stale upload success or an old unacknowledged row:
  `degraded`.
- Any dead-letter row: `degraded` with an operator-action reason.

Device counts and device state remain owned by `/api/control/devices`. Remove
the old heartbeat schema and do not keep a dual-schema runtime fallback.

## Test-First Implementation

### Phase 1: Stop data loss

Write failing daemon tests proving that old `pending` rows survive startup and
periodic cleanup and that only acknowledged uploaded rows pass retention. Then
remove `cleanup_all_old_pending()` and its callers.

Atomic commit:

```text
fix(outbox): never delete unacknowledged messages
```

### Phase 2: Stable identity

Write failing SQLite and serialization tests proving:

- every stored message has a stable UUID;
- the ID survives daemon restart and repeated upload attempts;
- the HTTP payload carries that exact ID; and
- identical message content can have distinct IDs.

Add the local migration and message field.

Atomic commit:

```text
feat(outbox): assign stable message IDs at ingestion
```

### Phase 3: Idempotent cloud acknowledgement

Write failing Worker tests for repeated IDs, distinct IDs with identical
content, lost responses, mixed per-message results, and side effects executing
only for new inserts. Then replace fuzzy deduplication and return per-ID results.

Atomic commit:

```text
fix(api): make message ingestion idempotent by source ID
```

### Phase 4: Leased indefinite delivery

Write failing daemon tests for:

- retry after more than five transient failures;
- capped backoff;
- daemon exit after claim;
- daemon exit after D1 commit but before local acknowledgement;
- expired-lease reclaim;
- per-message acknowledgement in a mixed batch; and
- permanent rejection entering `dead_letter` without deletion.

Implement the new state machine and remove the old `failed`/unleased
`uploading` paths.

Atomic commit:

```text
feat(outbox): replace capped retries with leased delivery
```

### Phase 5: Simplify heartbeat

Write failing daemon and Worker tests for the schema-v3 payload, empty-queue
idle behavior, stale non-empty queues, oldest-row age, and dead-letter reasons.
Replace schema v2 in a coordinated cutover; do not retain compatibility code.

Atomic commit:

```text
refactor(health): reduce heartbeat to pipeline health
```

### Phase 6: End-to-end fault tests

Exercise these boundaries with fixtures and mocks only:

1. Network unavailable for more than one hour.
2. D1 quota failure followed by recovery.
3. Daemon exit immediately after local persistence.
4. Daemon exit immediately after lease claim.
5. Worker commit followed by a lost HTTP response.
6. Multiple identical payloads with distinct stable IDs.
7. Delayed upload appearing through the existing dashboard cursor.

Expected result: every non-permanently-rejected local ID eventually has exactly
one corresponding D1 row, and no unacknowledged local row is deleted.

## Deployment Order

1. Deploy the daemon change that stops pending deletion and begins assigning and
   sending stable IDs. The current Worker already accepts a supplied `id`, so no
   new compatibility branch is required.
2. Verify new local IDs remain stable across retry and appear unchanged as D1
   `messages.id`.
3. Deploy the Worker contract that requires IDs, uses primary-key idempotency,
   returns per-ID acknowledgements, and deletes fuzzy deduplication.
4. Deploy the daemon leased-delivery state machine.
5. Cut heartbeat schema v3 over in one maintenance window. A brief monitoring
   gap is acceptable; the message pipeline must remain unaffected.
6. Observe queue age, acknowledgement behavior, D1 duplicates, and Query
   Insights before touching the legacy backlog.

No stage sends production SMS or queries carrier balances.

## Legacy Backlog Recovery

Do not blindly reset the current exhausted or stuck rows. An `uploading` row may
already exist in D1 even if the daemon missed the acknowledgement.

After stable-ID ingestion is deployed:

1. Take a read-only inventory of every legacy exhausted and stuck row.
2. Match each against D1 using its existing ICCID, exact content, direction, and
   narrow timestamp evidence.
3. Mark confirmed cloud matches uploaded.
4. Assign stable IDs to unmatched local rows and return them to `pending`.
5. Let the normal leased outbox drain them.
6. Verify local unacknowledged count reaches zero and no duplicate D1 rows were
   created.

Steps 3 and 4 mutate production state and require separate explicit approval.
The recovery should be a one-time operator command, not a permanent runtime
fallback.

## Verification Gates

Before each daemon deployment:

```bash
nix develop -c check-daemon
```

Before each Worker/frontend deployment:

```bash
cd sms-dashboard
bun run test
bun run build
```

Production verification is read-only until backlog recovery is explicitly
approved:

- Heartbeat remains current during an idle queue.
- A controlled mocked outage demonstrates growing queue age without deletion.
- Query Insights shows no fuzzy duplicate scan and no unbounded message scan.
- Stable IDs are identical in local SQLite upload logs and D1 metadata without
  exposing message contents.
- After approved recovery, `pending`, expired `in_flight`, and unexpected
  `dead_letter` counts are zero.

## Unresolved Questions

1. Uploaded local retention: retain the current seven-day target, or choose a
   different period? Recommended: seven days.
2. Dead-letter presentation: health panel and CLI only, or a dedicated dashboard
   view? Recommended first release: health panel plus CLI.
3. Legacy backlog recovery: approve only after the new idempotency path has been
   deployed and observed with new messages.
