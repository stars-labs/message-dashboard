# SMS Hardware Storage Safety Plan

## Status

Tracking plan created on 2026-08-14.

The problem statement and cautious staged approach are confirmed. Only the
assessment and observation work is approved at this point. No production SMS
read, persistence, deletion, multipart-assembly, polling, or scheduling behavior
may change until the corresponding stage gate in this document is explicitly
approved and recorded in the decision log.

The production daemon is currently useful and comparatively stable. Preserving
that state takes priority over improving storage handling or adding SIM balance
queries.

### Current stage

| Item | State |
| --- | --- |
| Current behavior documented | Complete (code-level baseline) |
| Baseline production evidence collected | In progress: 75-hour snapshot collected; seven-day window unavailable |
| Storage telemetry implementation | Not started |
| Storage telemetry enabled in production | Not approved |
| Delete-retry shadow mode | Not approved |
| Delete-retry execution | Not approved |
| Multipart early physical deletion | Not approved |
| Fleet-wide rollout | Not approved |

## Why This Plan Exists

Incoming SMS may be held in either the EC20 module's `ME` storage or the SIM
card's `SM` storage. If that physical storage fills, the modem may stop accepting
new SMS even though the Orange Pi, Cloudflare database, and dashboard are healthy.
If the modem fails while unread SMS exists in `ME`, those messages may also become
unrecoverable.

Long-term persistence in the Orange Pi SQLite queue and Cloudflare D1 is the
correct destination for SMS. Physical modem/SIM storage should be a short-lived
ingress buffer, not an archive.

This plan hardens that ingress buffer without destabilizing the existing receive
path.

## Scope

### Goals

- Detect real `ME` and `SM` usage before either storage fills.
- Preserve every readable SMS or raw PDU durably before physical deletion.
- Retry failed physical deletions independently from message deduplication.
- Prevent incomplete multipart SMS from accumulating indefinitely in hardware.
- Surface storage and deletion health without slowing normal SMS collection.
- Roll out every behavior change behind a default-off switch and ICCID allowlist.
- Keep Cloudflare outages from filling physical modem storage once a message is
  safely persisted on the Orange Pi.

### Non-goals

- Changing the Cloudflare D1 12-month retention policy.
- Reducing browser or server message history.
- Sending arbitrary AT commands from the dashboard.
- Adding a bulk-delete or `AT+CMGD=1,4` production workflow.
- Guaranteeing recovery from a modem failure that occurs before the daemon reads
  and persists a message.
- Implementing SIM balance queries before the safety gates below are satisfied.

## Current Production Behavior

The following is the code-level baseline as of 2026-08-14. It must be verified
against the running Orange Pi before implementation begins.

1. The daemon scans `ME` and `SM` independently. For EC20, `MT` is treated as an
   alias for `ME`, not as the union of `ME` and `SM`.
2. A decoded single-part message is first inserted into the Orange Pi SQLite
   message store.
3. After that local insert succeeds, the daemon immediately attempts to delete the
   exact physical `storage:index` using `AT+CMGD`.
4. Cloudflare upload happens asynchronously afterwards. Therefore local SQLite,
   not Cloudflare acknowledgement, is currently the physical-deletion durability
   boundary.
5. If physical deletion fails, the next scan normally sees a locally duplicated
   message. The duplicate branch currently does not retry physical deletion.
6. Multipart segments remain in physical storage until all parts assemble. The
   local segment cache expires after five minutes, but that cache cleanup does not
   delete the corresponding physical segments.
7. `AT+CPMS?` exists as a diagnostic, but physical `ME used/total` and
   `SM used/total` are not continuously parsed, stored, alerted, or shown in the
   dashboard.
8. The existing `check_sim_storage()` name is misleading: it checks local SQLite
   counters, not physical EC20/SIM capacity.

Relevant implementation areas:

- `orange-pi-daemon/src/at_modem.rs`: storage selection, listing, and `AT+CMGD`.
- `orange-pi-daemon/src/modem_manager.rs`: multipart buffering and physical paths.
- `orange-pi-daemon/src/message_store.rs`: local durability, deduplication, and
  segment storage.
- `orange-pi-daemon/src/main.rs`: reader, uploader, and cleanup task ordering.

## Safety Invariants

Every implementation and review must preserve these invariants.

1. **Persist before delete.** No readable SMS, segment, or raw PDU may be deleted
   from `ME` or `SM` before a successful durable local transaction.
2. **Exact location only.** A deletion targets an explicitly recorded storage and
   index. Never infer the active store and never bulk-delete.
3. **Deduplication is not deletion state.** A duplicate local message may still
   require a physical deletion retry.
4. **Idempotent retries.** Repeating a deletion task must not delete a newer SMS
   after an index is reused. Revalidation rules must be defined and tested before
   delete retry is enabled.
5. **No Cloudflare dependency for draining hardware.** Once local persistence is
   durable, a Cloudflare outage must not force SMS to remain in limited hardware
   storage.
6. **Normal SMS has priority.** Telemetry and cleanup must yield to receiving and
   sending SMS. Any command that can race modem operations must first be covered
   by an approved shared per-modem serialization boundary.
7. **Fail closed.** Ambiguous storage, index, parse result, or ownership means no
   physical deletion.
8. **Default off.** Every new behavior-changing feature is disabled unless
   explicitly enabled for an allowlisted ICCID.
9. **Fast rollback.** Disabling a flag must restore the previous behavior without
   a database rollback or daemon downgrade.
10. **No silent loss.** Unparseable content must be durably quarantined as raw
    input before any future policy is allowed to remove it from hardware.

## Stage 0 — Baseline and Regression Contract

**Behavior change:** none.

- [ ] Record the deployed daemon commit and build version. Version `8.0.0` is
  confirmed; the artifact does not expose its project commit.
- [ ] Record at least seven days of current modem-reader success/failure data. The
  retained journal currently covers only about 75 hours.
- [ ] Measure scan-cycle latency, messages received, duplicate count, deletion
  successes, deletion failures, multipart completions, and incomplete segments.
- [ ] Capture sanitized examples of `AT+CPMS=?`, storage-selection responses, and
  `AT+CPMS?` from representative EC20 firmware versions.
- [ ] Confirm whether incoming SMS is actually landing in `ME`, `SM`, or both for
  representative carriers.
- [x] Confirm the current per-modem operation lock covers storage selection,
  listing, sending, diagnostics, and deletion. Result: it does not; the reader
  cycle guard is not a shared per-modem operation lock.
- [x] Add regression tests that freeze the current single-part and multipart
  receive behavior before refactoring it.
- [x] Document how the operator confirms that a message visible in SQLite is also
  visible in Cloudflare after recovery from an API outage.

**Exit condition:** current behavior and failure frequency are supported by real
production evidence, and tests detect any unintended change to the receive path.

## Stage 1 — Observation-Only Physical Storage Telemetry

**Behavior change:** no SMS deletion or assembly change.

Prefer parsing the responses of storage-selection commands already executed by
the scan path. Do not add independent store-switching commands that could race the
reader. If an extra command is unavoidable, it must run inside the same per-modem
critical section and restore the complete previous `CPMS` configuration.

- [ ] Implement a parser for physical `used/total` values with fixture tests.
- [ ] Collect separate `ME` and `SM` samples without increasing scan failure rate.
- [ ] Add nullable, backward-compatible fields to the daemon health payload.
- [ ] Make the Worker accept both old and new health schemas before daemon rollout.
- [ ] Initially record telemetry only in daemon logs and structured health data.
- [ ] Add dashboard display only after payload compatibility is verified.
- [ ] Define alert bands provisionally as `<70%`, `70–85%`, `85–95%`, and `>=95%`.
- [ ] Validate those bands against actual storage capacities and traffic before
  enabling notifications.
- [ ] Observe for at least seven days with no statistically meaningful regression
  in modem-reader success or scan latency.

**Exit condition:** real `ME/SM` occupancy is visible and trustworthy, while the
SMS receive/delete behavior remains byte-for-byte equivalent to the baseline.

## Stage 2 — Persistent Deletion Queue in Shadow Mode

**Behavior change:** records proposed retries but does not execute new deletes.

- [ ] Separate local message identity, physical location, and physical deletion
  state in an additive local schema.
- [ ] Record every initial delete attempt and outcome.
- [ ] Generate shadow retry tasks for persisted messages whose physical deletion
  failed.
- [ ] Re-scan and report whether the original `storage:index` still contains the
  same message before declaring a shadow retry safe.
- [ ] Define a content fingerprint that does not expose SMS bodies in logs.
- [ ] Test index reuse, daemon restart, modem reconnect, SIM swap, store switch,
  duplicate delivery, and corrupt local state.
- [ ] Run shadow mode on one allowlisted ICCID for 48 hours.
- [ ] Expand shadow mode to five ICCIDs for at least seven days.
- [ ] Review every proposed deletion mismatch manually.

**Exit condition:** shadow mode proposes only exact, revalidated deletions and has
zero cases where an index now belongs to a different SMS.

## Stage 3 — Allowlisted Physical Deletion Retry

**Behavior change:** retries previously failed individual deletes.

Required controls:

```text
SMS_STORAGE_TELEMETRY_ENABLED=false
SMS_DELETE_RETRY_ENABLED=false
SMS_DELETE_RETRY_ICCID_ALLOWLIST=
```

Names may change during implementation, but the independent controls and
default-off behavior may not.

- [ ] Enable retry for one low-risk ICCID only.
- [ ] Limit deletes per modem per cycle.
- [ ] Revalidate storage, index, and fingerprint immediately before deletion.
- [ ] Treat “already absent” as successful convergence, not an error.
- [ ] Stop retries after SIM swap, ICCID mismatch, ambiguous read, or lock timeout.
- [ ] Expose consecutive delete failures and last success in daemon health.
- [ ] Provide one-step rollback by disabling `SMS_DELETE_RETRY_ENABLED`.
- [ ] Observe one ICCID for 48 hours, then five for seven days.
- [ ] Reconcile local, Cloudflare, and physical-storage counts.

**Exit condition:** deletion failures converge without loss, incorrect deletion,
reader slowdown, or modem instability.

## Stage 4 — Multipart Segment Hardware Drain

**Behavior change:** potentially deletes individual physical segments after each
segment is durably persisted, before the complete SMS is assembled. This is the
highest-risk stage and requires separate approval.

- [ ] Store enough raw metadata to reconstruct and audit every segment locally.
- [ ] Prove the local transaction is durable before physical deletion.
- [ ] Test missing, duplicated, reordered, conflicting, and reused reference IDs.
- [ ] Test crashes before commit, after commit, after physical deletion, and before
  final assembly.
- [ ] Test SQLite full, read-only filesystem, corruption, and daemon restart.
- [ ] Preserve incomplete messages for operator review rather than silently
  discarding them.
- [ ] Run on a non-production modem or controlled test SIM first.
- [ ] Require explicit approval before any production ICCID is allowlisted.

**Exit condition:** multipart reconstruction survives every tested interruption and
hardware occupancy drains without SMS loss.

## Stage 5 — High-Water Response and Fleet Rollout

High-water handling must remain a safe acceleration of the normal pipeline:

```text
read exact item -> durable local commit -> revalidate -> individual delete
```

It must never become “storage high, therefore delete everything.”

- [ ] Add operator-visible warning and critical states.
- [ ] Increase safe drain priority at the agreed threshold without starving normal
  receiving or outbound sending.
- [ ] Test the kill switch under high occupancy.
- [ ] Expand from one ICCID to five, one carrier group, and then the fleet.
- [ ] Hold each expansion for at least seven days.
- [ ] Keep a manual spare-modem and SIM-move procedure for hardware failure.
- [ ] Record which SIMs use `ME` versus `SM` and evaluate whether a verified `SM`
  preference improves recoverability without creating a smaller-capacity risk.

**Exit condition:** the fleet remains below the agreed physical occupancy threshold
and no stage introduces message loss or receive-path regression.

## Required Test Matrix

| Scenario | Required result |
| --- | --- |
| Cloudflare unavailable | SMS persists locally; hardware can drain safely. |
| Orange Pi process restart | No duplicate upload and no unsafe index deletion. |
| EC20 disconnect/reconnect | Pending work resumes only after ICCID and location validation. |
| SIM swap | All delete retries for the previous ICCID stop. |
| First `AT+CMGD` fails | Persistent retry/shadow record remains. |
| Index reused by newer SMS | Old retry is rejected. |
| `ME` readable, `SM` fails | Reader continues safely and reports partial storage failure. |
| `SM` readable, `ME` fails | Reader continues safely and reports partial storage failure. |
| Multipart part missing | Persisted parts remain auditable; no silent message loss. |
| Raw PDU cannot parse | Raw input is quarantined; no deletion without approved policy. |
| SQLite write fails | Physical SMS is not deleted. |
| Local disk full | Physical SMS is not deleted; critical alert is emitted. |
| Storage reaches warning threshold | Operator sees exact modem, ICCID, store, used, and total. |

## Compatibility and Deployment Order

For any health-payload or dashboard work:

1. Add backward-compatible Worker storage/API support.
2. Deploy and verify Worker compatibility with the old daemon.
3. Deploy the frontend, treating new fields as optional.
4. Deploy the telemetry-only daemon with behavior flags off.
5. Observe before enabling a flag for any ICCID.

Never deploy a frontend or Worker that requires a daemon field the currently
deployed daemon does not send.

## Rollback Checklist

- [ ] Disable the stage-specific feature flag.
- [ ] Remove all ICCIDs from its allowlist.
- [ ] Confirm normal modem-reader success resumes.
- [ ] Confirm no background task continues issuing new delete commands.
- [ ] Preserve new local records for audit; do not destroy evidence during rollback.
- [ ] Verify Cloudflare upload queue and daemon health.
- [ ] Record incident time, affected ICCIDs/modems, build version, and recovery.

## Relationship to SIM Balance Queries

The [SIM Balance Query Plan](./sim-balance-query-plan.md) introduces carrier SMS
replies and later USSD operations. It depends on this plan because those replies
consume the same modem resources and physical SMS storage.

Balance-query carrier validation may continue only as a tightly controlled manual
test. Automated balance scheduling must not begin until at least:

- Stage 1 telemetry is stable;
- physical delete failures are visible;
- a rollback switch exists; and
- the pilot SIM's `ME/SM` capacity is known.

## Weekly Status Log

Add one row for every observation period, rollout change, rollback, or decision.
Do not overwrite prior evidence.

| Date | Stage | Scope/build | Observation | Decision/next step |
| --- | --- | --- | --- | --- |
| 2026-08-14 | Planning | Repository review | Current design is locally durable before physical deletion, but delete-failure retry, multipart physical cleanup, and real `CPMS` monitoring have gaps. | Create this tracking plan. No behavior change approved. |
| 2026-08-14 | Stage 0 | Repository `f073b72` | Code-level receive path and operation serialization documented. Read-only SSH to both known Orange Pi addresses timed out, so deployed version and production metrics are not yet verified. | Add regression coverage locally; resume production evidence collection when read-only access returns. |
| 2026-08-14 | Stage 0 | Local Rust tests | Added storage-path, duplicate-path, and incomplete-multipart regression cases. Specialized suite: 29 passed. Full suite: 197 passed, 0 failed, 1 ignored doctest. | Keep runtime behavior unchanged; begin the seven-day production baseline after read-only access is restored. |
| 2026-08-14 | Stage 0 | Rust validation gate | Uniformly formatted the daemon crate. Added `check-daemon`, a `nix flake check` format derivation, and a pre-test format gate to the daemon Nix build. | All future daemon validation and deployment builds must pass `cargo fmt --all --check`. |
| 2026-08-14 | Stage 0 | Production access retry | Initial SSH attempts were blocked by the local execution sandbox and produced no remote output. An approved read-only retry later succeeded. | No production routing or daemon change was needed. |
| 2026-08-14 | Stage 0 | Production read-only snapshot, daemon `8.0.0` | Service is active. Retained 75-hour window: 21,530 scans at 11.53 s average, 4 per-modem read failures, 0 explicit delete failures, and 956,797 multipart-completion logs. Journal is about 1 GB. SQLite snapshot contains 520 recent multipart segments in 354 groups. | Treat repeated multipart assembly as a high-priority baseline finding. Do not change deletion behavior or query `CPMS` until serialization and retry safety are reviewed. |

## Decision Log

| Date | Item | Decision | Evidence/notes |
| --- | --- | --- | --- |
| 2026-08-14 | Persistence boundary | Confirmed direction | Long-term persistence belongs in local SQLite and Cloudflare D1; `ME/SM` is a temporary ingress buffer. |
| 2026-08-14 | Stability priority | Confirmed | The currently useful production receive path must not be disrupted by this work. |
| 2026-08-14 | Rollout strategy | Confirmed | Assessment, observation, shadow mode, one-ICCID canary, five-ICCID soak, then gradual rollout. |
| 2026-08-14 | Bulk deletion | Prohibited | Do not introduce an automated `AT+CMGD=1,4` path. |
| 2026-08-14 | Behavior changes | Pending approval | Telemetry planning is allowed; delete retry and multipart early deletion require later explicit gates. |
| 2026-08-14 | Per-modem serialization | Gap confirmed | The worker-pool guard serializes reader cycles only. No common per-modem lock covers reading, sending, diagnostics, store selection, and deletion; Stage 1 must not add independent `CPMS` switching. |
| 2026-08-14 | Repeated multipart assembly | Investigation required | Identical redacted multipart signatures recur every reader cycle. Code and logs indicate physical segments may survive local deduplication without a delete retry. This is not authorization to change runtime behavior. |

## Evidence Index

Store sanitized artifacts under `docs/evidence/sms-storage/`. Never commit SMS
bodies, phone numbers, secrets, or raw production PDU content. Record hashes,
redacted fixtures, aggregate counts, build versions, and time ranges instead.

Suggested files:

```text
docs/evidence/sms-storage/
  baseline-2026-08-14.md
  cpms-fixtures-redacted.txt
  canary-<redacted-iccid>-YYYY-MM-DD.md
  rollback-YYYY-MM-DD.md
```
