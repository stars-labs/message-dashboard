# Prepaid SIM Balance and Recharge Workflow Plan

Status: prepaid health and the discovery-only M1 portal profile are implemented
locally as of 2026-08-24. No live M1 balance query, recharge, deployment, or
production mutation has been performed for this feature.

## 1. Outcome

Keep every managed prepaid SIM usable by turning verified balance and expiry
observations into a clear, auditable operator queue.

The workflow is carrier-neutral. Carrier profiles determine only how observations
are obtained and parsed; one shared workflow decides whether attention is needed.
The first Singapore cohort is S73-S77: five carrier-account-verified M1 prepaid
SIMs. The official M1 prepaid portal has now been confirmed to support mobile-number
plus SMS OTP login and to display both cash balance and account validity. Automation
remains discovery-only until a controlled end-to-end runner query succeeds.

The first release monitors and coordinates recharge. It never purchases a top-up,
submits payment, stores payment credentials, or calls an undocumented carrier API.

## 2. Domain decisions

1. Prepaid health is SIM-level unless a carrier account or contract explicitly
   proves that several SIMs share one wallet. Equal balances or similar messages
   are not evidence of a shared wallet.
2. The latest valid typed metrics are the source of truth for balance and expiry.
   The system derives health from them; it does not store a second mutable copy of
   `current_balance`, `is_low`, `is_stale`, or `is_expiring`.
3. A query failure never deletes or replaces the last successful observation. The
   dashboard shows the last known value together with the failed-query state.
4. Low balance and approaching expiry are independent reasons. A SIM may show both
   simultaneously; a single priority badge must not hide the other reason.
5. Recording that an operator recharged a SIM is not proof of the new balance.
   The SIM remains `verification_pending` until a later carrier observation confirms
   a usable balance and, when available, expiry.
6. `service_type = prepaid` is manually verified inventory metadata. A parser,
   balance amount, expiry date, or recharge event never changes `service_type`.
7. Currency and metric meaning come from a versioned carrier profile or a controlled
   manual observation. The system never guesses them from message text alone.
8. Data, SMS, and voice allowances remain informational and deferred for health
   calculation. First-release actionable metrics are `cash_balance` and
   `account_expiry`.

## 3. Observation sources

All sources produce the existing immutable balance-check and typed-metric shape.
They differ only in provenance and confidence.

### Automated carrier observation

Use only a verified, enabled carrier profile following the discovery order in
[SIM Balance Query Plan](sim-balance-query-plan.md): official USSD, carrier SMS,
official API or business integration, then browser automation. Each result retains
the profile and parser version, raw response or safe reference, timestamps, and
failure reason.

### Controlled manual observation

For app-only or portal-only carriers, an administrator may record an observation
after viewing the official carrier surface. The form requires:

- SIM identity, observed balance, ISO currency, and observation time.
- Account/SIM expiry when the carrier exposes it; otherwise an explicit
  `not_available` expiry outcome.
- Source type: `carrier_app`, `carrier_portal`, `carrier_support`, or
  `carrier_statement`.
- A short non-secret note. Do not store passwords, OTPs, session data, full payment
  card data, or screenshots containing sensitive account information.

Manual observations use `method = manual` and an immutable audit record. They never
enable an automated carrier profile. Editing is replacement-by-new-observation,
not mutation of history.

### Passive carrier alerts

Low-balance, expiry, recharge-success, and service-suspension SMS messages may
support the workflow only through exact, versioned, fixture-backed carrier parsers.
A passive alert can add an action reason or prove that a top-up was accepted only
when its wording has an unambiguous meaning. It changes balance or expiry metrics
only when the message explicitly states those values. Generic promotions and
top-up advertisements are ignored. No fuzzy or AI parser changes balance state.

## 4. Health and action derivation

The server evaluates all reasons on each read using Singapore calendar dates for
Singapore SIMs and the SIM's configured region for other cohorts.

Action reasons:

- `query_failed`: the latest query failed or timed out after the approved retries.
- `automation_unsupported`: no verified automated profile exists; this is a
  capability reason, not by itself a service-health failure.
- `never_observed`: no successful balance observation exists.
- `stale`: the latest successful actionable observation is older than 35 days.
- `zero_or_negative_balance`: confirmed cash balance is at or below zero.
- `low_balance`: confirmed cash balance is below the regional threshold.
- `expired`: confirmed expiry is before the current local calendar date.
- `expiring_soon`: confirmed expiry is within 30 calendar days, including today.
- `expiry_unknown`: the carrier profile is expected to expose expiry but no valid
  expiry has been obtained.
- `verification_pending`: an operator recorded a recharge but no later carrier
  observation has verified it.

Default low-balance thresholds remain CNY 100, SGD 10, and HKD 100. Thresholds are
server-side policy keyed by currency and region, not copied into every SIM row.

The summary status is derived only for sorting and compact display, in this order:
`expired`, `zero_or_negative_balance`, `query_failed`, `verification_pending`,
`stale`, `low_balance`, `expiring_soon`, `never_observed`, `healthy`. The API also
returns the complete reason list so no concurrent problem is hidden. A SIM with a
fresh manual observation can be healthy while also reporting
`automation_unsupported`.

## 5. Operator workflow

1. The monthly scheduler queries SIMs with enabled profiles. It uses the existing
   per-SIM jitter, 24-hour duplicate guard, and at most three once-daily retries.
2. The server derives action reasons from the latest successful metrics and latest
   query outcome.
3. The dashboard places actionable SIMs in the prepaid queue, ordered by service
   risk and then expiry date, balance, and SIM identifier.
4. An administrator reviews the query audit. If automation is unsupported, the UI
   offers `Record manual observation` rather than a nonfunctional query button.
5. For low balance or expiry risk, an administrator may record `recharge_planned`,
   then perform the recharge outside this system.
6. The administrator records `recharge_submitted` with amount, currency, channel,
   time, and an idempotency key. This creates an audit event but does not alter the
   observed balance.
7. The system requests a fresh observation when a verified automated method exists;
   otherwise it asks for a controlled manual observation. The normal 24-hour query
   guard may be bypassed once for this explicit post-recharge verification, but the
   per-carrier rate limit and modem serialization still apply.
8. A later observation verifies the recharge only if it is newer than the submitted
   event and shows the SIM outside the triggering balance/expiry condition. A balance
   increase alone is retained as evidence but does not prove expiry extension unless
   the carrier returns a new expiry.
9. Ambiguous, mismatched-currency, or lower-than-expected results enter
   `needs_review`; they are never silently treated as success.

## 6. Data model

Continue using `sim_balance_checks` and `sim_balance_metrics` as the immutable source
for automated and manual observations. Extend them only as needed with controlled
source values; do not create a second latest-balance table.

Add `prepaid_maintenance_actions`:

- `id`, `sim_iccid`, `reason`, and triggering `balance_check_id`.
- `status`: `open`, `recharge_planned`, `verification_pending`, `verified`,
  `dismissed`, or `needs_review`.
- Optional planned/submitted recharge amount in integer minor units and ISO
  currency.
- `recharge_channel`: `carrier_app`, `carrier_portal`, `voucher`, `retailer`,
  `bank`, or `other`.
- `opened_at`, `planned_at`, `submitted_at`, `resolved_at`, `created_by`, and
  `version` for optimistic concurrency.
- One active action per SIM and reason family. Repeated scheduler reads must not
  create duplicates.

Add `prepaid_maintenance_events` as the append-only audit for `opened`,
`recharge_planned`, `recharge_submitted`, `observation_recorded`, `verified`,
`dismissed`, `reopened`, and `review_required`. Events store the actor or system
source, timestamp, related check, idempotency key, and structured non-secret
metadata.

Derived health remains independent of action status: dismissing an action does not
make a low balance healthy, and an action can reopen when the underlying condition
still exists.

## 7. API and authorization

Reuse `balances.read` for observation and health visibility and
`balances.query` for verified automated queries. Add:

- `prepaid_actions.read`: viewer and admin.
- `prepaid_actions.write`: admin only.
- `balance_observations.write`: admin only for controlled manual observations.

Carrier-neutral endpoints:

- `GET /api/prepaid-sims` with health, reason, carrier, capability, and date filters.
- `GET /api/prepaid-sims/:iccid` with metrics, queries, active action, and events.
- `POST /api/prepaid-sims/:iccid/manual-observations`.
- `POST /api/prepaid-sims/:iccid/actions/plan-recharge`.
- `POST /api/prepaid-sims/:iccid/actions/submit-recharge`.
- `POST /api/prepaid-sims/:iccid/actions/dismiss` and `/reopen`.
- `POST /api/prepaid-sims/:iccid/verify` to enqueue an allowed query or request a
  manual observation.

Every write requires an idempotency key. Action transitions require the expected
version. The server obtains the actor from Auth0; clients cannot supply audit actor
identities.

## 8. Dashboard

The Balance module has three views:

1. `SIM balances`: prepaid health and maintenance queue.
2. `Postpaid bills`: account-level bill-payment queue.
3. `Query history`: automated and manual observation audit.

The prepaid view shows SIM, carrier, balance, currency, expiry, all action reasons,
observation age and source, automation capability, latest query outcome, active
maintenance state, and available admin action. It never aggregates money across
currencies.

Default ordering places expired and zero-balance SIMs first, then query failures,
recharge verification, low balances, upcoming expiry, stale/missing data, and
healthy SIMs. Filters cover reason, carrier, currency, source, automation support,
and action status. Mobile uses full-width rows and exposes the same reasons without
horizontal scrolling.

For `service_type = postpaid`, the prepaid view shows the postpaid-account state or
an account-link warning instead of a prepaid threshold. For `unknown`, it shows the
observed typed metrics plus `Service type not verified` and does not invent a
prepaid action solely from the inventory type.

## 9. M1 first-cohort validation

Use S73-S77 as the first genuine Singapore prepaid cohort. The old `#100#` attempt
on S78 is invalid M1 evidence because S78 is verified Singtel postpaid.

1. Confirm the five SIMs remain M1 prepaid and select one low-risk, online pilot.
2. Confirmed on 2026-08-24: `https://mcardaccount.m1.com.sg/login` accepts an
   eight-digit M1 prepaid number and six-digit SMS OTP. The authenticated balance
   surface displays SGD cash balance and `Valid Till DD Mon YYYY` account expiry.
3. Test official `#100#` only in a serialized maintenance window on the genuine M1
   pilot, with complete asynchronous response capture, timeout, cancellation, and
   proof that normal SMS scanning resumes.
4. Compare the result with the official M1 Prepaid Portal or app through a human
   login. CAPTCHA, MFA, and app interaction remain operator handoffs.
5. If USSD is deterministic, capture two successful observations on different days
   before enabling a profile. If it is not, keep M1 manual-observation-only; do not
   guess an SMS command or reverse engineer the app API.
6. The M1 portal profile promises both `cash_balance` and `account_expiry`; a result
   missing either field fails closed and does not create a partial successful
   observation.

No live USSD, SMS, portal login, balance query, or production change is authorized
by this plan.

## 10. Test-first implementation sequence

Each stage is one atomic commit and starts with a failing test.

1. **Pure health policy:** clock-controlled tests cover thresholds, concurrent
   reasons, stale data, expiry boundaries, missing metrics, failed queries, and
   unsupported-but-fresh manual observations.
2. **Manual observation schema/API:** tests prove immutable history, controlled
   source values, integer money, valid currencies/dates, RBAC, and idempotency.
3. **Maintenance actions:** tests cover deduplication, allowed transitions,
   optimistic concurrency, immutable events, dismissal without health mutation,
   and reopening.
4. **Recharge verification:** tests prove that operator submission cannot modify
   balance, only later observations can verify it, and ambiguous observations
   require review.
5. **Overview API/UI:** tests cover reason-preserving sorting and filters,
   viewer/admin controls, postpaid exclusion, unknown service type, and mobile
   layout.
6. **M1 profile:** only after controlled carrier evidence, add sanitized positive
   and negative fixtures plus modem timeout/cancellation tests.
7. **Scheduler:** tests cover monthly jitter, retries, 24-hour guard, the single
   post-recharge verification exception, carrier rate limits, and modem priority.

Required gates are `nix develop --command bun run test`,
`nix develop --command bun run build`, migration validation against a fresh local
D1 database, `git diff --check`, and desktop plus 440-pixel visual verification.

## 11. Rollout

1. Ship derived health and read-only prepaid queue from existing observations.
2. Ship controlled manual observations for unsupported carriers.
3. Ship maintenance actions without any in-system payment or recharge integration.
4. Validate M1 on one genuine cohort SIM; compare with the official carrier surface.
5. Expand an enabled profile to all five M1 SIMs only after two successful pilot
   observations and seven days without disrupting SMS collection.
6. Add other carriers through their own versioned profiles; reuse the shared health,
   action, audit, API, and UI workflow.
7. Consider automated recharge only as a separate future project with explicit
   payment authorization, approval policy, spending limits, idempotency, and
   before/after reconciliation.

## 12. Unresolved questions

1. Should the first release record recharge planning/submission, or stop at a
   read-only action queue? Recommended: record both, but keep recharge external and
   require a later observation for verification.
2. Who may record manual observations and recharge events? Recommended:
   administrators only; viewers remain read-only.
3. Should `expiry_unknown` be actionable when a carrier exposes no expiry method?
   Recommended: show it as informational for unsupported profiles and actionable
   only when the enabled profile promises an expiry result.
4. Should post-recharge verification bypass the 24-hour query guard once?
   Recommended: yes, only for an explicit submitted action and still subject to
   carrier rate limits and modem safety.
5. Is SGD 10 still the desired threshold for all Singapore prepaid products?
   Recommended: keep SGD 10 for the first release, then introduce a versioned
   product policy only if operating evidence shows materially different needs.
