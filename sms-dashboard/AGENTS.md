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
- Auth: browser → Auth0 JWT + RBAC; daemon → `API_KEY`. Middleware: CORS → JWT → RBAC.

Full schema and auth contracts: [docs/data-contracts.md](../docs/data-contracts.md)

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

- Server changes: `bun run test`
- Frontend changes: `bun run build` + check desktop and 440px mobile layouts
- Cross-component: run every affected component's gate

## UI rules

- Desktop: dense, quiet, scan-optimized.
- Mobile: edge-to-edge content, no outer gaps.
- Search filters records — no substring highlighting.
- Verification code tap → copy with explicit toast feedback.
- Balances belong to the Balance module, not the Device/SIM table.
- No new Svelte accessibility warnings.
