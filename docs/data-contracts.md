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
