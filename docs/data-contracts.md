# Data and Authorization Contracts

## Schema rules

- `sims` is the user-owned inventory and the source of truth for ICCID, phone
  number, carrier, SIM index, and assigned IMEI. The daemon never writes it.
- `sims.service_type` is `unknown`, manually verified `prepaid`/`postpaid`, or
  `balance_managed` when operational health is driven directly by balance metrics.
  Never infer or write it from ICCID, detected operator, or balance replies.
- Read device/SIM state through `device_view`, not ad hoc joins or legacy tables.
- `device_view` joins `sims.imei` to `modems.equipment_id`. The join key is IMEI,
  not ICCID.
- Use `modems.detected_iccid`; `modems.current_iccid` is stale legacy data frozen
  since migration `033` — never query it.
- `modem_state` was removed by migration `033`; signal fields live on `modems`.
- The v8 daemon syncs through `/api/control/devices`. The pre-`033`
  `/api/control/phones` route was removed; do not reintroduce it.
- SIM indices are displayed as `S` plus two digits (`S01`, `S36`) everywhere.
  Reuse the centralized formatter instead of formatting individual views.
- Daemon health and SIM state are different domains. A healthy daemon can report
  offline SIMs; legacy activity must not make a schema-v1 daemon healthy.

## Authentication contracts

- Browser users authenticate with Auth0 JWTs and RBAC. Daemon/legacy control
  clients authenticate with `API_KEY`.
- Middleware order is CORS → Auth0 JWT → RBAC.
- Balance Agent requires scopes `balance:runners:heartbeat`,
  `balance:skills:run`, and `balance:browser:run`.
- Migration `057` binds Dashboard-created balance work to the requesting Auth0
  `sub` via `sim_balance_checks.requested_by_subject`.
- An Auth0 Balance Agent may see, claim, and mutate only work owned by the same
  Auth0 `sub`. A different user's online Agent must not satisfy preflight or claim
  that work.
- `NULL` ownership is reserved for legacy API-key jobs. Do not weaken this
  compatibility boundary.

## Carrier billing contracts

- Postpaid bills belong to `carrier_billing_accounts`, never directly to a SIM and
  never to `sim_balance_checks` or `sim_balance_metrics`.
- `carrier_billing_account_sims` contains only manually verified membership. The
  notification SIM, message parser, carrier, and SIM index must not infer account
  membership.
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
  performs the one-time exact normalization of confirmed Singtel senders.

Browser users need `bills.read` to list accounts and read bills. Administrators need
`bills.write` for account configuration, bill actions, and historical backfill.

Carrier-neutral routes:

- `GET /api/carrier-billing/accounts`
- `POST /api/carrier-billing/accounts`
- `POST /api/carrier-billing/accounts/:id/update`
- `POST /api/carrier-billing/accounts/:id/members/preview`
- `POST /api/carrier-billing/accounts/:id/members`
- `POST /api/carrier-billing/backfill/preview`
- `POST /api/carrier-billing/backfill/execute`
- `GET /api/carrier-bills`
- `GET /api/carrier-bills/:id`
- `POST /api/carrier-bills/:id/payment-planned`
- `POST /api/carrier-bills/:id/mark-paid`
- `POST /api/carrier-bills/:id/waive`
- `POST /api/carrier-bills/:id/reopen`

Every billing write takes the actor from the verified Auth0 identity. Bill actions,
account mutations, and backfill execution require an idempotency key and the exact
expected version. Backfill execution additionally requires the exact digest returned
by a read-only preview.
