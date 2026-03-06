# SMS Dashboard — Project Context

## Overview
Distributed SMS management system for **100+ USB modems** on Orange Pi hardware.
- **Production URL**: https://sexy.qzz.io
- **Daemon version**: v8.0.0 (Rust, direct AT commands)
- **Orange Pi target**: 203.116.95.146 (aarch64-linux, NixOS)

## Architecture
```
Orange Pi (Rust Daemon) → Cloudflare Workers API → Svelte 5 Frontend
    ↓                         ↓                        ↓
USB Modems (AT/D-Bus)    D1 Database (SQLite)     Auth0 + RBAC
```

## Key Directories
| Path | Purpose | Tech |
|------|---------|------|
| `orange-pi-daemon/` | Hardware daemon (~5700 LOC) | Rust + Tokio async |
| `sms-dashboard/client/` | Frontend SPA | Svelte 5 + TailwindCSS + Vite 7 |
| `sms-dashboard/server/` | Backend API (JS) | Cloudflare Workers |
| `sms-dashboard/migrations/` | DB migrations (~25 files) | SQL (D1) |
| `nixos-config/` | System config | NixOS flake + SOPS |
| `ansible/` | Deploy automation | Ansible |
| `sql/` | DB maintenance queries | SQL |
| `docs/` | Documentation | Markdown |

## Commands
```bash
# Frontend
cd sms-dashboard && bun install && bun run dev      # Dev server :5173
bun run dev:api                                       # Wrangler local API
bun run build                                         # Production build
bun run deploy                                        # Build + deploy to CF

# Database
npx wrangler d1 execute sms-dashboard --local --file=migrations/schema.sql
npx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"
npx wrangler tail sms-dashboard --format pretty       # Live API logs

# Rust daemon
cd orange-pi-daemon && cargo build --release
cargo test                                            # Run unit tests (24 tests)
RUST_LOG=debug cargo run

# NixOS deploy
nixos-rebuild switch --flake .#orange-pi --target-host root@10.171.150.102 --build-host root@10.171.150.102 --use-substitutes --impure

# Modem debug (on Orange Pi)
mmcli -L                                              # List modems
mmcli -m 0                                            # Modem details
journalctl -u sms-daemon -f                           # Daemon logs
```

## Environment Variables (Daemon)
```bash
SMS_API_URL="https://sexy.qzz.io"   # API endpoint
SMS_API_KEY="<from wrangler secrets>" # Must match API_KEY in Workers
RUST_LOG="orange_pi_daemon_rust=info" # Log level
MESSAGE_DB_PATH="/var/lib/sms-daemon/messages.db" # Local SQLite queue
USE_DBUS="0"                         # Set "1" to use ModemManager D-Bus instead of AT commands
```

Cloudflare secrets (set via `npx wrangler secret put <NAME>`):
`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `API_KEY`

## Database Schema (Cloudflare D1)
- `modems` — hardware devices (PK: equipment_id/IMEI)
- `sims` — SIM cards (PK: iccid), FK to modems
- `modem_state` — volatile signal/connection data, FK to modems
- `messages` — SMS content, FK to sims
- `daemon_health` — heartbeat monitoring
- `device_view` — backward-compat view joining modems+sims+state

## Gotchas and Patterns

### Must-know
- **Always use `device_view`** for reading device data — never query raw tables directly
- **Package manager is `bun`**, not npm — all scripts use `bunx`
- **No linters/formatters configured** — follow existing code style in each component
- **No WebSocket/SSE in production** — manual refresh only (cost optimization). The websocket code exists but is commented out in `App.svelte`
- **Router is custom** — `SimpleRouter` class in `server/index.js`, not itty-router (despite itty-router being in package.json)

### Daemon gotchas
- AT commands are primary interface (1-5ms). D-Bus/ModemManager is fallback only (50ms)
- ModemManager has a deletion bug — daemon auto-cleans old pending messages every 5min as workaround
- Local SQLite queue (`message_store.rs`) buffers messages when network is down, uploads in batches of 10-100
- Worker pool runs 6 concurrent modem readers; Tokio runtime uses 4 threads (ARM optimized)
- Signal cache: 30s TTL, 256-entry hash — avoid redundant modem queries

### Server gotchas
- Middleware chain order: CORS → Auth0 JWT → RBAC (order matters)
- Daemon authenticates with API key header, users with Auth0 JWT
- 13 handler modules in `server/handlers/` — new endpoints go there
- AI features use Cloudflare Vectorize + AI bindings (configured in `wrangler.toml`)

### Network
- Orange Pi IPs: `10.171.150.102` (internal LAN), `203.116.95.146` (deploy target)
- Sync intervals: device status every 30s, full sync every 5min (keeps under CF rate limits)
