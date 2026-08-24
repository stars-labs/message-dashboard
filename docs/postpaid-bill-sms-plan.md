# Singapore Postpaid Bill SMS Workflow Plan

Status: the receiving-SIM auto-discovery design and migrations `066`–`069` were
deployed on 2026-08-24. Production evidence confirmed that only S79 received all
nine retained Singtel bill notices. Historical reconciliation completed on
2026-08-24: production has one S79 bill stream, nine billing cycles, zero
`needs_review` records, and no bill stream for any other SIM. After operator
confirmation that the historical cycles had already been handled, the eight bills
due before 2026-08-24 were reconciled to `paid` with immutable audit events. The
2026-09-07 bill remains the only open cycle.

## 1. Outcome

Turn an authentic bill-ready SMS from any supported Singapore carrier into an
account-level payment task that remains visible until an authorized user records
its resolution.

This is one shared Singapore postpaid workflow, not a Singtel-specific product
feature. Carrier-specific behavior is isolated in versioned parser profiles. The
first evidence-backed profile is Singtel postpaid: retained production evidence
contains nine consecutive monthly notices delivered to S79, each with a single
billing-account reference, an SGD amount, and a due date. The other Singtel SIMs did
not receive equivalent bill notices.

This workflow is passive: it never sends an SMS, logs in to a carrier, or performs a
payment.

## 2. Domain decisions

1. A payment task belongs to the current SIM that actually receives the bill SMS.
2. The first authentic notice automatically creates one internal bill stream for
   that receiving SIM. Operators do not configure an account number or member list.
3. The system links only the receiving SIM to its stream and never infers that other
   SIMs share the bill. Current production evidence identifies S79 only.
4. The billed amount is immutable evidence. Payment workflow state is stored
   separately and may be changed only by an authorized user.
5. A new bill never marks an older bill as paid. Payment is confirmed manually in
   the first release.
6. Due status is derived from `due_date`, the current Singapore calendar date, and
   payment state. It is not persisted as a second source of truth.
7. Existing `sim_balance_checks` and `sim_balance_metrics` remain SIM-query data.
   A postpaid account bill must not be copied into those tables or duplicated across
   all linked SIMs.
8. The raw carrier message remains in `messages`. Normalized billing records store
   only the fields needed for the workflow and a link to the source message.

## 3. Data model

Add four carrier-neutral tables in one append-only D1 migration.

### `carrier_billing_accounts`

- `id`: stable generated identifier.
- `country_code`, `carrier`, `currency`, and operator-facing `display_name`.
- `notification_sim_iccid`: the SIM expected to receive notices.
- `account_ref_digest`: deterministic SHA-256 digest discovered from the authentic
  SMS and used for matching without repeating the full reference in normalized
  tables. It is never operator input.
- `account_ref_last4`: masked display only.
- `status`: `pending_verification`, `active`, or `inactive`.
- `created_by`, `created_at`, and `updated_at`.

The digest is pseudonymization, not encryption. Access control remains the security
boundary, and the full reference remains visible only in the retained source SMS.

### `carrier_billing_account_sims`

- `billing_account_id` and `sim_iccid` composite identity.
- `verification_source`: `carrier_account`, `contract_or_bill`, or
  `carrier_support`.
- `verified_at`, `verified_by`, and optional `removed_at`.
- A partial unique index permits only one active billing-account mapping per SIM.

Automatic bill-stream discovery writes only the receiving SIM to this table with
`contract_or_bill` evidence. No other membership is inferred.

### `carrier_bills`

- `id`, `billing_account_id`, and nullable `source_message_id`.
- `amount_minor` as integer cents and ISO `currency`; never floating-point money.
- `due_date` as an ISO calendar date, not a timestamp.
- `received_at` and `parser_version`.
- `action_status`: `unpaid`, `payment_planned`, `paid`, `waived`, or
  `needs_review`.
- `payment_planned_at`, `paid_at`, `paid_by`, and optional operator note.
- `version` for optimistic concurrency.
- Unique constraints on `source_message_id` and `(billing_account_id, due_date)`.

If a second notice has the same account and due date but a different amount, the
system records a conflict and changes the bill to `needs_review`; it never silently
replaces the amount.

The source-message foreign key uses `ON DELETE SET NULL` so the existing 12-month
message-retention job cannot be blocked. The normalized bill and audit events remain.

### `carrier_bill_events`

Append-only audit records for `detected`, `duplicate_detected`, `parse_conflict`,
`payment_planned`, `paid`, `waived`, and `reopened`. Each event records the actor or
system source, timestamp, optional source-message link, and structured non-secret
metadata.

## 4. Carrier parser profiles

Every supported Singapore carrier has a separate deterministic parser profile with
its own exact senders, message templates, fixtures, parser version, and enablement
state. The shared workflow accepts normalized output only; it contains no fuzzy
cross-carrier parser and never assumes that one carrier's wording applies to
another.

Initial profile registry:

| Profile | Carrier | Evidence | State |
| --- | --- | --- | --- |
| `sg-singtel-postpaid-bill-sms-v1` | Singtel | Nine retained monthly bill notices on S79 | Deployed |
| — | StarHub | No current StarHub inventory or confirmed postpaid bill template | Unsupported pending evidence |
| — | M1 | Current M1 cohort is prepaid; no confirmed postpaid bill template | Unsupported pending evidence |

A new carrier profile requires at least two authentic notices from different billing
cycles, sanitized parser fixtures, negative fixtures, and a controlled preview. It
starts disabled and is enabled only for explicitly mapped billing accounts.

### Singtel profile

Create a deterministic profile named `sg-singtel-postpaid-bill-sms-v1`.

Eligibility requires all of the following:

- The receiving SIM is configured as the notification SIM for an active Singtel
  billing account.
- The inventory carrier is Singtel and `service_type` is `postpaid`.
- The canonical sender is exactly `Singtel`.
- The body matches the confirmed bill-ready template and contains one account
  reference, one `SGD` amount, and one due date.

The parser returns `amount_minor`, `currency`, `due_date`, a masked account suffix,
and the account-reference digest. It rejects ambiguous amounts, invalid dates,
unsupported currencies, account mismatches, rebates, advertisements, OTPs, and
generic messages that merely contain the word “bill”. It does not use AI.

The retained S79 evidence contains six complete messages and three two-part
messages. Complete messages include the carrier's trailing fill character; the
reassembled historical messages do not. Fragment matching uses the same receiving
SIM and canonical sender, requires a non-negative gap of at most five minutes, and
chooses the closest unused continuation. Equal timestamps are valid because D1's
secondary ID ordering does not preserve multipart order.

Historical rows contain a numerically encoded form of the sender `Singtel`, while
recent rows are canonical. First protect the current decoder with a regression
fixture. If the fixture proves the defect is already fixed, leave ingestion alone;
otherwise fix it at the source. Normalize the known historical rows once in an
append-only migration. Do not maintain two permanent sender paths.

## 5. Detection and reconciliation

1. The daemon uploads the received SMS normally.
2. After insertion, the Worker passes eligible messages to the pure parser.
3. A successful match creates or idempotently finds the bill, then appends a
   `detected` event.
4. A duplicate message appends `duplicate_detected` without creating another bill.
5. A conflicting amount creates `parse_conflict` and requires human review.
6. The existing nightly Worker cron scans recent eligible messages without a bill
   event and retries them. This closes the gap if request-scoped processing fails.
7. An admin-only backfill endpoint provides preview and execute phases for the nine
   retained historical notices. Execution is a separate production action requiring
   explicit authorization.

The upload endpoint must continue accepting the SMS if optional bill processing
fails. Failures are logged and left for nightly reconciliation rather than causing
the daemon to resend the same message batch.

## 6. Action state and urgency

The API derives the presentation state each time it reads a bill:

- `needs_review`: parser conflict or operator review required.
- `paid` or `waived`: resolved.
- `overdue`: unresolved and the Singapore date is after `due_date`.
- `due_soon`: unresolved and due within seven calendar days, including today.
- `open`: unresolved and more than seven days remain.

`payment_planned` remains actionable and can still become overdue. It communicates
intent but is not proof of payment.

The first release provides in-app attention only. It does not send reminder SMS,
email, or push notifications and does not initiate payment.

## 7. API and authorization

Add explicit permissions:

- `bills.read`: viewer and admin.
- `bills.write`: admin only.

Add carrier-neutral endpoints:

- `GET /api/carrier-billing/accounts`
- `GET /api/carrier-bills` with status, carrier, account, and date filters
- `GET /api/carrier-bills/:id` with source-message and event audit
- `POST /api/carrier-bills/:id/payment-planned`
- `POST /api/carrier-bills/:id/mark-paid`
- `POST /api/carrier-bills/:id/waive`
- `POST /api/carrier-bills/:id/reopen`
- Admin historical-backfill preview and execute endpoints

Every write requires the expected `version` and an idempotency key. The server takes
the actor from the verified Auth0 identity; clients cannot supply `paid_by`.

## 8. Dashboard

Extend the Balance module to three views:

1. `SIM balances`: existing prepaid and queried-metric overview.
2. `Postpaid bills`: account-level payment queue.
3. `Query history`: existing balance-query audit.

The bill queue shows receiving SIM, carrier, amount, due date, days remaining,
derived urgency, and action state. Default order
is `needs_review`, `overdue`, `due_soon`, `open`, then resolved bills; within each
group, the earliest due date comes first.

The bill detail drawer shows normalized fields, the receiving SIM, the source SMS while it
is retained, and the immutable event history. Admins can record planned, paid,
waived, or reopened states. Viewers are read-only.

For a postpaid SIM that has received a bill SMS, the overview displays “Received bill
SMS”. It must not show “balance unavailable” or apply the SGD prepaid threshold. A
postpaid SIM without a matching notice shows “Waiting for bill SMS”.

## 9. Implemented migrations

- `066_add_carrier_billing.sql`: carrier-neutral billing accounts, verified SIM
  memberships, immutable bill evidence, action state, and bill audit events.
- `067_add_carrier_billing_account_events.sql`: optimistic account versions,
  mutation ownership, and immutable account-configuration audit events.
- `068_normalize_singtel_senders.sql`: exact received-message normalization for the
  two confirmed decimal-ASCII Singtel sender encodings.
- `069_unique_active_billing_stream_per_sim.sql`: one active automatically
  discovered bill stream per receiving SIM.

Migrations `066`–`069` are in production.

## 10. Test-first implementation sequence

Each stage is one atomic commit and starts with a failing test.

1. **Canonical sender:** daemon and Worker fixtures reproduce the historical numeric
   sender. Preserve the current canonical behavior or fix it if still reproducible,
   then add the historical normalization migration.
2. **Pure parser:** add sanitized fixtures for all nine confirmed notices plus
   negative fixtures for rebates, OTPs, generic bill text, malformed dates,
   ambiguous amounts, and account mismatch.
3. **Schema:** migration tests prove money uses integer cents, the receiving-SIM
   stream is unique, source-message deletion is safe, duplicates are idempotent, and amount
   conflicts cannot overwrite evidence.
4. **Detection:** handler tests cover new messages, duplicates, conflicts, parser
   failure isolation, and nightly recovery.
5. **API/RBAC:** route and full permission-matrix tests cover read/write separation,
   optimistic concurrency, idempotency, and immutable events.
6. **Overview logic:** clock-controlled tests cover open, seven-day warning,
   due-today, overdue, payment-planned, paid, waived, and needs-review states.
7. **UI:** component tests cover sorting, filtering, viewer/admin actions, SIMs with
   and without received bill SMS, mobile layout, and source-message retention expiry.
8. **Backfill preview:** fixture-based integration test proves the nine retained
   messages yield nine bills for one account without writing during preview.

All eight stages are complete and deployed. The production preview recognized six
complete notices and three controlled two-fragment reconstructions, producing nine
billing cycles. Execution remains guarded by the exact account version, preview
digest, admin permission, and an idempotency key.

The 2026-08-24 production execution created only the S79 receiving-SIM stream. Its
nine bills cover due dates from 2026-01-07 through 2026-09-07; all parsed without a
conflict, and none require review. Independent post-execution aggregation confirmed
zero active bill streams for other SIMs. A subsequent operator-confirmed status
reconciliation recorded the eight past-due historical cycles as paid, leaving zero
overdue bills and one future unpaid cycle due on 2026-09-07.

Required gates are `nix develop --command bun run test`,
`nix develop --command bun run build`, migration validation against a fresh local
D1 database, `git diff --check`, and desktop plus 440-pixel visual verification.

Automated verification passes for the full test suite, production build, and fresh
local migration application. Browser-based desktop and 440-pixel visual verification
is pending because the in-app browser runtime cannot initialize in this environment.

## 11. Rollout

1. Deploy migration `069` and the receiving-SIM discovery code.
2. Run reconciliation so the nine retained S79 notices automatically create S79's
   bill stream and complete notices.
3. Preview historical processing; compare all nine normalized amounts and dates
   with the source SMS.
4. With explicit production approval, process any controlled fragments and review
   the dashboard.
5. Observe the next live monthly notice. Confirm one bill, one event, correct urgency,
   and no effect on message ingestion.
6. Add StarHub, M1, or another Singapore carrier only from separately confirmed
   templates and fixtures. Reuse the account, bill, action, API, and UI workflow;
   add only the new carrier parser profile.

## 12. Unresolved questions

1. Is the bill paid manually or by GIRO/automatic payment? Recommended: retain
   manual confirmation in either case; later add a distinct `autopay_expected`
   stream flag if needed.
2. Who may record a bill as paid? Recommended: administrators only for the first
   release.
3. Is seven days the desired due-soon window? Recommended: start with seven days and
   keep it a single server-side constant until operating evidence justifies making
   it configurable.
4. Which future Singapore postpaid carrier cohort should be validated next?
   Recommended: wait until the inventory contains a verified postpaid cohort and at
   least two genuine bill notices, then add only that carrier's parser profile.
