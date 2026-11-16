# SMS Dashboard — Agent Guide

> Cloudflare Worker API + Svelte 5 + Bun frontend + D1 database.

## Package manager

**Bun** — use `bun`, `bunx`. Never npm/pnpm/yarn.

## Data model (quick ref)

- `device_view` — always use for reads. Never query raw tables directly.
- `sims` — user inventory, source of truth. Daemon never writes it.
- `sims.service_type` — manually verified. Never infer from ICCID or balance replies.
- `modems.detected_iccid` — live field. `modems.current_iccid` is dead legacy.
- `modem_state` dropped in migration `033` — signal fields are on `modems`.
- SIM indices: `S` + two digits (`S01`, `S36`) — use the centralized formatter.
- Auth: browser → Auth0 session + RBAC; daemon → `API_KEY`; Balance Agent →
  `API_KEY` or an Auth0 token with the route's scope. Each route declares which.

Full schema and auth contracts: [docs/data-contracts.md](../docs/data-contracts.md)

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

The dashboard calls it as `contractApi.iccidMappings.get({ params: { id } })`
(`client/lib/api.ts`), the Balance Agent through `balance-agent/src/runner/control-client.ts`.
`bun run lint` rejects the old ways back: an `/api/` URL in `client/` or
`balance-agent/src/`, a server import of `handleAuth0`, `authorize`,
`requireApiKey` or `authorizeRunnerControl` outside `server/contract/handler.ts`,
and `searchParams` / `URLSearchParams` in `server/` outside the OAuth redirects
(`server/handlers/auth0.ts`). The legacy `Router` in `server/app.ts` serves only
those redirects, CORS preflight and the app shell.

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
Apply with: `bunx wrangler d1 execute sms-dashboard --remote --file=migrations/NNN_name.sql`
Do **not** use `wrangler d1 migrations apply --remote`.

## Deploy

See [docs/deployment.md](../docs/deployment.md).

## Verification

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
- Cross-component: run every affected component's gate

## UI rules

- Desktop: dense, quiet, scan-optimized.
- Mobile: edge-to-edge content, no outer gaps.
- Search filters records — no substring highlighting.
- Verification code tap → copy with explicit toast feedback.
- Balances belong to the Balance module, not the Device/SIM table.
- No new Svelte accessibility warnings.
