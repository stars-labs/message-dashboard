# SMS Dashboard — Agent Guide

> Cloudflare Worker API + Svelte 5 + Bun frontend + D1 database.

## Package manager

**Bun** — use `bun`, `bunx`. Never npm/pnpm/yarn.

## Data model (quick ref)

- `device_view` — always use for device reads. Only `server/db/sims.ts` touches
  `sims` and only `server/db/modems.ts` touches `modems`; lint enforces both.
- `sims` — user inventory, source of truth. Daemon never writes it.
- `sims.service_type` — manually verified. Never infer from ICCID or balance replies.
- `modems.detected_iccid` — a modem's ICCID.
- `modem_state` dropped in migration `033` — signal fields are on `modems`.
- SIM indices: `S` + two digits (`S01`, `S36`) — use the centralized formatter.
- Auth: browser → Auth0 session + RBAC; daemon → `API_KEY`; Balance Agent →
  `API_KEY` or an Auth0 token with the route's scope. Each route declares which.

Full schema and auth contracts: [docs/data-contracts.md](../docs/data-contracts.md)

## Recurring D1 read budget

- For a new or changed polling, heartbeat, retry, or scheduled path, record the
  call interval, expected number of callers, and estimated daily D1 rows read in
  the change review. Include idle calls, each statement in a batch, and retry
  traffic. Multiply reads per invocation by invocations per day across callers
  and check the estimate against the account-wide daily allowance.
- Bound the reads by an indexed key or range, the active queue, or a bounded
  cursor window. Historical rows outside that scope must not increase the cost
  of a poll. This applies to `UPDATE` and `DELETE` too. An empty result, zero
  rows written, or a `LIMIT` alone does not establish a read bound.
- Before changing recurring SQL, add a regression test to the existing test
  suite. Exercise the real entry point on `createSchema`, including competing
  indexes, with an empty queue and substantial unrelated history. Also cover
  applicable active work. Check the actual statements and bound parameters
  with `EXPLAIN QUERY PLAN` or a rows-read assertion. Check the index and range
  that bound the reads. Rerun the affected tests when a migration changes an
  index used by a recurring path.
- After an authorized production deployment, use read-only D1 Query Insights
  to verify executions and total rows read for the changed queries against the
  estimate. Record the observed time window and database with the result.

## Adding an API route

Every `/api/*` route is declared on the contract, in `shared/api/contract/`, with
`route(access, method, path)`; it says who may call it, and the schemas say what
goes in and out:

```ts
// shared/api/contract/iccid-mappings.ts
get: route({ kind: 'user', permission: 'phones.read' }, 'GET', '/api/iccid-mappings/{id}')
  .route({ inputStructure: 'detailed' })
  .input(v.object({ params: v.object({ id: v.string() }) }))
  .output(IccidMappingDetailResponse),

// server/contract/router.ts: the caller is admitted and the input parsed before this runs
get: os.iccidMappings.get.handler(({ context, input }) =>
  iccidMappingsHandler.get(context.request, input.params.id),
),
```

The handler (`server/handlers/`) holds the logic; its SQL lives in `server/db/`,
one file per domain. A db function takes the narrowest `D1<…>` it needs, parses
rows with `queryAll` / `queryFirst` / `queryOne`, and runs a whole `batch` (a
transaction) itself. `bun run lint` rejects `.prepare(` or `.batch(` outside
`server/db/`, and `CREATE` / `DROP` / `ALTER` anywhere in `server/`: the schema
changes only in `migrations/`.

The dashboard calls it as `contractApi.iccidMappings.get({ params: { id } })`
(`client/lib/api.ts`), the Balance Agent through `balance-agent/src/runner/control-client.ts`.
`bun run lint` rejects the old ways back: an `/api/` URL in `client/` or
`balance-agent/src/`, a server import of `handleAuth0`, `authorize`,
`requireApiKey` or `authorizeRunnerControl` outside `server/contract/handler.ts`,
and `searchParams` / `URLSearchParams` in `server/` outside the OAuth redirects
(`server/handlers/auth0.ts`). The legacy `Router` in `server/app.ts` serves only
those redirects and the app shell. Why oRPC, and its quirks:
[ADR 0001](../docs/adr/0001-api-contract-orpc.md).

## Types and tests

Lint enforces most of this (`strictTypeChecked`, no `as`, no `.first<T>()`); these
are the rules it cannot see.

- A value from outside the process (request, D1 row, KV value, `fetch` response,
  IPC, browser storage) is `unknown` until a valibot schema parses it. JSON text
  goes through `parseJson` / `readJson` (`shared/parse-json.ts`), a request body
  through the route's contract input, built with `bodyObject` (`shared/api/body.ts`).
- A row schema sits next to its query and lists exactly the selected columns. A
  column is non-null only when the table declares it `NOT NULL` or primary key,
  or the view expression cannot yield null.
- A closed set of values is a `v.picklist`, switched over exhaustively; never
  widen it to `string`. Branded types such as `Iccid` come only from schemas. A
  caught error stays `unknown` and is read with `errorText` (`shared/error-text.ts`).
- A function takes the narrow ports in `server/lib/` (`D1<'all' | 'first'>`,
  `KV<'get'>`), not `Env` or the request. Its tests pass plain objects with just
  those members.
- SQL behavior is tested on real SQLite (`test/sqlite-d1.ts`) over `createSchema`
  tables, never on canned rows.
- `worker-runtime.d.ts` and `worker-configuration.d.ts` are generated by
  `wrangler types`; `check:worker-types` fails on any hand edit.

## Development

```bash
# Normal workflow:
dev-server restart    # frontend :8080 + API :8787
dev-server status
dev-server logs
dev-server stop

# Isolated debugging only:
dev-frontend          # Vite on 127.0.0.1:8080
dev-api               # Wrangler on :8787, secrets via SOPS

# Test and build:
cd sms-dashboard
bun run test
bun run build
```

## D1 migrations

Add a new numbered file — never rewrite an applied migration.
`bun run check:migrations` (part of `bun run check`) rejects a change to any
migration on `origin/main`, and a new one not named `NNN_name.sql` above main's
highest number.
Apply with: `bunx wrangler d1 execute sms-dashboard --remote --file=migrations/NNN_name.sql`
Do **not** use `wrangler d1 migrations apply --remote`.

The baseline is `migrations/schema.sql` (structure) plus `reference-data.sql` (the
`sim_balance_profiles` rows only migrations write), exported from production; its
`-- through: NNN` header names the last migration included. Tests build every
database with `createSchema` (`test/schema.ts`): baseline, then each newer
migration. `bun run lint` rejects `CREATE TABLE|INDEX|VIEW|TRIGGER` in a test outside
`migrations/`, whose tests start from the tables before their migration. After a migration reaches
production, regenerate both files and run `bun run check:schema-drift`
([deployment](../docs/deployment.md)).

### Bulk D1 quota preflight

Apply this before production table copies or rebuilds, index builds on existing
data, backfills, and bulk updates or deletes, including retention jobs.

- In the change review, record the affected table sizes and estimated D1 rows
  read and written per operation and in total. Include table copies, index
  entries, triggers, and foreign-key actions. Rehearse the exact SQL on isolated
  D1 with representative row counts and indexes. Capture `meta.rows_read` and
  `meta.rows_written` where available, and document conservative estimates for
  operations without measurements.
- Before executing in production, check the account's remaining read and write
  allowance for the current quota window. Reserve room for normal database
  traffic through the next reset, including daemon heartbeats, SMS uploads, and
  outbound claims. Proceed only when the change and the reserve fit both
  budgets. If they do not fit, prefer an additive schema change, use resumable
  batches across quota windows, or obtain approval for a Cloudflare plan with
  sufficient allowance. A quiet deploy window does not increase the daily limit.
- For batches, define the maximum rows and budget per batch, a checkpoint, and
  a stopping point that preserves the reserve. Record the recovery procedure
  and a Time Travel bookmark for table rebuilds. After an authorized rollout,
  compare the account's measured usage with the estimate and check that the
  daemon has written a new heartbeat.

## Deploy

See [docs/deployment.md](../docs/deployment.md).

## Verification

- Coverage: `bun run test` (and the Balance Agent's) write lcov reports to
  `coverage/`; `bun run check` ends with `check:coverage`, which fails when the
  line or function total of the runtime, client or agent suite falls below its
  floor in `scripts/check-coverage.ts`. Raise a floor when coverage rises; never
  lower one to make a change pass.
- Server changes: `bun run test`. `test/worker-harness.ts` drives the whole Worker;
  adding, removing or reordering a route means updating `server/route-census.test.ts`,
  and a route that answers without credentials must be listed, with its reason, in
  `server/route-auth.test.ts`.
- `/api/control/*` is what the Pi daemon and the Balance Agent speak, and they
  cannot be rolled back with the Worker. `shared/control-fixtures/` records each
  exchange; the Worker, the daemon and the agent are all tested against it. A
  fixture changes only when every client changes with it.
- Routes on the contract (`shared/api/contract/`): `bun run openapi` regenerates
  `openapi.json`, which `bun run check` compares with the contract.
  `check-api-compat` lists breaking changes against `origin/main` and fails for
  `/api/control/*`; CI runs it on every pull request.
- Frontend changes: `bun run build` + check desktop and 440px mobile layouts.
  With `dev-server` running, `bun run screenshots -- --out <dir>` captures every
  view at both widths and writes `report.html` with console errors and failed
  requests. It signs in with a temporary admin session in local KV, no login.
- `bun run e2e` (CI runs it on every push and pull request) starts the real Worker
  on a fresh local D1 built by `bun run db:init` plus
  `scripts/e2e/seed.sql`, with Auth0 answered by `scripts/e2e/fake-auth0.ts`, and
  opens every view in `shared/views.ts` at 1440px and 440px. A view fails on a
  console error or warning, a page error, a failed or 4xx/5xx request, a redirect
  away from it, or sideways scroll on mobile; screenshots land in `e2e-results/`.
  A new view is covered by adding it to `shared/views.ts`; data it needs goes in
  the seed.
- Behavior: e2e proves a view renders; the `verify` skill
  ([`.claude/skills/verify/`](../.claude/skills/verify/SKILL.md)) proves a feature
  works. `bun run verify` drives one journey on the same stack, with the daemon's
  calls and a sandboxed Balance Agent; its feature map says what to drive and what
  counts as proof. A change to `/api/control/*` runs both journeys in
  `scripts/verify/journeys/` besides the fixtures.
- Cross-component: run every affected component's gate

## UI rules

- Desktop: dense, quiet, scan-optimized.
- Mobile: edge-to-edge content, no outer gaps.
- Search filters records — no substring highlighting.
- Verification code tap → copy with explicit toast feedback.
- Balances belong to the Balance module, not the Device/SIM table.
- No new Svelte accessibility warnings.
