# SMS Dashboard

Cloudflare-hosted SMS operations dashboard for the Orange Pi modem fleet.
Production is available at <https://sexy.qzz.io>.

Repository-wide development, secret, migration, and deployment rules live in
[`../AGENTS.md`](../AGENTS.md). Read them before running production commands.

## Stack

- Svelte 5, Tailwind CSS, and Vite for the frontend.
- A JavaScript Cloudflare Worker with the local `SimpleRouter` implementation in
  `server/index.js`.
- Cloudflare D1 for SIM inventory, modem state, messages, balance workflows, and
  audit records.
- Auth0 JWT authentication and fail-closed RBAC for users.
- API-key authentication for the Orange Pi daemon and legacy control clients.
- An Electron Balance Agent for local AI/VPN and interactive carrier-browser work.

There is no production WebSocket or SSE transport. The UI uses request/refresh
flows to avoid persistent Cloudflare connections.

## Layout

```text
client/             Svelte application and component tests
server/             Worker handlers, middleware, utilities, and tests
migrations/         Sequential D1 SQL migrations
config/             Auth0 role and permission configuration
runner-core/        Shared authenticated Balance Agent capabilities
balance-agent/      Electron menu-bar application
scripts/            Build, maintenance, and developer runner adapters
wrangler.toml       Production Worker and binding configuration
```

## Local Development

Use the Nix-owned supervisor from the repository root. It starts one frontend on
`:8080` and one local Worker API on `:8787`, injecting development credentials
through the existing SOPS wrapper without writing plaintext files.

```bash
nix develop --command dev-server restart
nix develop --command dev-server status
nix develop --command dev-server logs
```

Open <http://localhost:8080>. Do not run additional Vite or Wrangler development
servers alongside `dev-server`.

For isolated component work:

```bash
cd sms-dashboard
bun install
bun run test
bun run build
```

## Data Model

- `sims`: user-managed inventory and source of truth for ICCID, phone number,
  carrier, SIM index, and assigned IMEI.
- `modems`: daemon-owned hardware state keyed by `equipment_id`/IMEI. Current SIM
  detection is stored in `detected_iccid`; signal and USB state also live here.
- `device_view`: primary SIM-centric read view joining inventory to hardware by
  `sims.imei = modems.equipment_id`.
- `messages`: inbound and outbound SMS records and classification state.
- `daemon_health`: schema-v1 daemon health snapshot.
- `sim_balance_*`: balance profiles, checks, conversations, metrics, runner jobs,
  and audits.

`modem_state` was removed by migration `033`. `modems.current_iccid` is legacy,
and the incompatible `/api/control/phones` route has been removed. The v8 daemon
syncs through `/api/control/devices` and consumers use `detected_iccid`.

## Authentication

- Interactive users receive Auth0 JWTs and the `sms-viewer` or `sms-admin` role.
- The Worker requires `AUTH0_AUDIENCE` when requesting API access tokens.
- Balance Agent requests only `balance:runners:heartbeat`, `balance:skills:run`,
  and `balance:browser:run`.
- Dashboard-created balance jobs are scoped to the requesting Auth0 `sub`; another
  user's Agent cannot satisfy readiness or claim them.
- The daemon authenticates control requests with `X-API-Key`.

## Migrations

Production predates Wrangler migration bookkeeping. Never run
`wrangler d1 migrations apply --remote`. Inspect the remote schema and execute only
the exact new migration file:

```bash
CLOUDFLARE_ACCOUNT_ID=793e3286eaca411bf1eebaf4b8c7051e \
  bunx wrangler d1 execute sms-dashboard --remote \
  --file=migrations/NNN_name.sql
```

Applied migrations are immutable. Prefer additive, backward-compatible changes.

## Deployment

Confirm `bunx wrangler whoami` shows the intended Google-authenticated `@bitgc.io`
identity and Cloudflare account, then deploy:

```bash
cd sms-dashboard
CLOUDFLARE_ACCOUNT_ID=793e3286eaca411bf1eebaf4b8c7051e bun run deploy
curl -fsS https://sexy.qzz.io/api/health
```

Record the Worker version printed by Wrangler and verify the affected authenticated
workflow after deployment.

## Balance Agent

Development commands:

```bash
cd sms-dashboard/balance-agent
bun install
bun run test
bun run build
bun run start
```

The planned internal release is Nix-built, ad-hoc signed, checksummed, and published
to this repository's private GitHub Releases. The release flake outputs are still
pending; see [`../docs/balance-agent-product-plan.md`](../docs/balance-agent-product-plan.md).
