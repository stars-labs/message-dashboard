# Data and Authorization Contracts

## Schema rules

- `sims` is the user-owned inventory and the source of truth for ICCID, phone
  number, carrier, SIM index, and assigned IMEI. The daemon never writes it.
- `sims.service_type` is `unknown`, manually verified `prepaid`/`postpaid`, or
  `balance_managed` when operational health is driven directly by balance metrics.
  Never infer or write it from ICCID, detected operator, or balance replies.
- Read device/SIM state through `device_view`, not ad hoc joins or legacy tables.
  In the Worker only `server/db/sims.ts` reads or writes `sims` and only
  `server/db/modems.ts` reads or writes `modems`; `bun run lint` enforces it.
- `device_view` joins `sims.imei` to `modems.equipment_id`. The join key is IMEI,
  not ICCID.
- A modem's ICCID is `modems.detected_iccid`; migration `081` dropped the legacy
  `current_iccid`.
- `modem_state` was removed by migration `033`; signal fields live on `modems`.
- The v8 daemon syncs through `/api/control/devices`. The pre-`033`
  `/api/control/phones` route was removed; do not reintroduce it.
- SIM indices are displayed as `S` plus two digits (`S01`, `S36`) everywhere.
  Reuse the centralized formatter instead of formatting individual views.
- The SIMs in this fleet do not carry their MSISDN (Singtel and M1 never
  provision it), so `AT+CNUM` returns nothing. Phone numbers come only from
  `sims.phone_number`, entered by an operator.
- `messages.phone_iccid` has no foreign key to `sims`: messages arrive for ICCIDs
  that are not in the inventory yet.
- Daemon health and SIM state are different domains. A healthy daemon can report
  offline SIMs; legacy activity must not make a schema-v1 daemon healthy.
- Daemon liveness is the Worker's receive time (`last_heartbeat =
  CURRENT_TIMESTAMP`). The Pi's wall clock never decides whether it is online.
- A batch query is a `sim_balance_batches` row; its checks carry `batch_id`.
  Cancelling a batch (migration `084`) cancels only checks nobody has started: still
  `queued`, with their outbound SMS still `sending` (the daemon has not taken it) or
  their browser job still `pending`. In one transaction the check becomes
  `cancelled`, its SMS `cancelled` and its job `stopped`. A cancelled check is not a
  failure: it counts toward neither the 24-hour cooldown nor 查询失败.
- `sim_balance_checks` is referenced, directly or through `messages`, by nine
  tables. Changing one of its constraints means rebuilding all ten, as `084` does:
  D1 cannot turn foreign keys off, and dropping a parent runs its children's
  `ON DELETE` actions even with `defer_foreign_keys` on.

## Authentication contracts

- Browser users authenticate with Auth0 JWTs and RBAC. Daemon/legacy control
  clients authenticate with `API_KEY`.
- Every `/api/*` route declares its access on the contract. `server/contract/handler.ts`
  admits the caller (API key, runner token, or Auth0 session plus permission)
  before the input is parsed.
- Balance Agent requires scopes `balance:runners:heartbeat`,
  `balance:skills:run`, and `balance:browser:run`.
- Migration `057` binds Dashboard-created balance work to the requesting Auth0
  `sub` via `sim_balance_checks.requested_by_subject`.
- An Auth0 Balance Agent may see, claim, and mutate only work owned by the same
  Auth0 `sub`. A different user's online Agent must not satisfy preflight or claim
  that work.
- `NULL` ownership is reserved for legacy API-key jobs. Do not weaken this
  compatibility boundary.
- A job call's `runner_id` is the Agent's session ID. A claim, and every call that
  reads or advances a leased job (decision, OTP request and poll, job heartbeat,
  complete), is refused (403) unless a heartbeat has registered that session under an
  unrevoked installation signed in the same way (same API key mode, or same Auth0
  `sub`). Fail and release stay open, so a revoked runner can still give a job back.
- An admin with `runners.write` revokes an installation
  (`balance_runner_installations.revoked_at`): its heartbeats and job calls are
  refused from then on. The installation ID is the Agent's own, so revocation stops
  that installation, not the account's credential: whoever holds the Mac and resets
  the Agent's settings gets a new installation ID. Cutting off a lost Mac completely
  still means revoking the user's Auth0 sessions.

## Carrier billing contracts

- Postpaid bill tasks are keyed by the current SIM that actually receives an
  authentic carrier bill SMS. They never use `sim_balance_checks` or
  `sim_balance_metrics`.
- The first authentic bill SMS automatically creates one active internal billing
  stream for its receiving SIM. `carrier_billing_account_sims` contains only that
  receiving SIM; the system never infers other SIM membership.
- The carrier account reference is parsed from the SMS only to validate a stable
  stream and is stored as a digest plus masked suffix. Operators never configure or
  supply it.
- `carrier_bills.amount_minor` is integer minor currency units. Bill evidence fields
  are immutable; operator actions update only workflow fields using optimistic
  concurrency.
- `carrier_bill_events` and `carrier_billing_account_events` are append-only audit
  logs. Source-message references may become `NULL` after message retention without
  deleting normalized bills or their audit history.
- Bill urgency is derived at read time from the Singapore calendar date, `due_date`,
  and action state. It is not persisted.
- Migration `066` owns billing accounts, memberships, bills, and bill events;
  migration `067` owns account versions and account audit events; migration `068`
  performs the one-time exact normalization of confirmed Singtel senders; migration
  `069` enforces one active bill stream per receiving SIM.
- Each carrier has its own deterministic parser profile (exact senders and
  templates, no AI, no cross-carrier fuzzy matching). Only Singtel's
  (`sg-singtel-postpaid-bill-sms-v1`) exists. A new profile needs two authentic
  notices from different billing cycles, sanitized positive and negative
  fixtures, and a controlled preview; it starts disabled.

Browser users need `bills.read` to list accounts and read bills. Administrators need
`bills.write` for account configuration and bill actions.

Carrier-neutral routes:

- `GET /api/carrier-billing/accounts`
- `GET /api/carrier-bills`
- `GET /api/carrier-bills/:id`
- `POST /api/carrier-bills/:id/payment-planned`
- `POST /api/carrier-bills/:id/mark-paid`
- `POST /api/carrier-bills/:id/waive`
- `POST /api/carrier-bills/:id/reopen`

Every user billing write takes the actor from the verified Auth0 identity. Bill
actions require an idempotency key and the exact expected version.
