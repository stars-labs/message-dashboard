# SMS Dashboard — Project Context

## Compact Instructions

When compressing, preserve in priority order:

1. Architecture decisions (NEVER summarize)
2. Modified files and their key changes
3. Current verification status (pass/fail)
4. Open TODOs and rollback notes
5. Tool outputs (can delete, keep pass/fail only)

## Overview
Distributed SMS management system for **100+ USB modems** on Orange Pi hardware.
- **Production URL**: https://sexy.qzz.io
- **Daemon version**: v8.0.0 (Rust, direct AT commands, ~7000 LOC)
- **Orange Pi SSH**: `root@10.171.150.102` (internal LAN, NixOS aarch64)
- **Orange Pi public**: `203.116.95.146` (deploy target)

## Architecture
```
Orange Pi (Rust Daemon) → Cloudflare Workers API → Svelte 5 Frontend
    ↓                         ↓                        ↓
USB Modems (AT/D-Bus)    D1 Database (SQLite)     Auth0 + RBAC
```

### Data Model (SIM-Centric)
```
sims (user inventory, 95 rows)     ← Source of truth, daemon NEVER writes
  └─ device_view                   ← PRIMARY read view, all queries use this
       ├─ LEFT JOIN modems         ← Daemon-detected hardware (by current_iccid)
       └─ LEFT JOIN modem_state    ← Volatile signal/connection data
```
- **Active** = SIM's ICCID found in a modem's `current_iccid` field
- **Inactive** = SIM exists in inventory but not currently in any modem
- Primary ID is `iccid` (stable), not `equipment_id` (changes with USB position)

## Key Directories
| Path | Purpose | Tech |
|------|---------|------|
| `orange-pi-daemon/` | Hardware daemon (~7000 LOC) | Rust + Tokio async |
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
bunx wrangler d1 execute sms-dashboard --local --file=migrations/schema.sql
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"
bunx wrangler tail sms-dashboard --format pretty       # Live API logs

# Rust daemon
cd orange-pi-daemon && cargo build --release
cargo test                                            # Run unit tests (61 tests)
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

Cloudflare secrets (set via `bunx wrangler secret put <NAME>`):
`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `API_KEY`

## Database Schema (Cloudflare D1)
- **`sims`** — user SIM inventory (PK: iccid). Source of truth for phone_number, carrier, sim_index. Daemon NEVER writes here.
- `modems` — daemon-detected hardware (PK: equipment_id/IMEI). `current_iccid` links to which SIM is inserted.
- `modem_state` — volatile signal/connection data, FK to modems
- `messages` — SMS content, FK to sims
- `daemon_health` — heartbeat monitoring
- **`device_view`** — SIM-centric read view (sims LEFT JOIN modems LEFT JOIN modem_state). Use for ALL reads.

## Gotchas and Patterns

### Must-know
- **Always use `device_view`** for reading device data — never query raw tables directly
- **Package manager is `bun`**, not npm — all scripts use `bunx`
- **No linters/formatters configured** — follow existing code style in each component
- **No WebSocket/SSE in production** — manual refresh only (cost optimization). All WS/SSE code has been removed.
- **Router is custom** — `SimpleRouter` class in `server/index.js`, not itty-router

### Daemon gotchas
- AT commands are primary interface (1-5ms). D-Bus/ModemManager is fallback only (50ms)
- ModemManager has a deletion bug — daemon auto-cleans old pending messages every 5min as workaround
- Local SQLite queue (`message_store.rs`) buffers messages when network is down, uploads in batches of 10-100
- Worker pool runs 6 concurrent modem readers; Tokio runtime uses 4 threads (ARM optimized)
- Signal cache: 30s TTL, 256-entry hash — avoid redundant modem queries

### Server gotchas
- Middleware chain order: CORS → Auth0 JWT → RBAC (order matters)
- Daemon authenticates with API key header, users with Auth0 JWT
- 8 handler modules in `server/handlers/` — new endpoints go there

### Network
- Orange Pi IPs: `10.171.150.102` (SSH/internal LAN), `203.116.95.146` (public/deploy target)
- Sync intervals: device status every 30s, full sync every 5min (keeps under CF rate limits)

### SIM detection gotchas
- **Modem ID = USB port position**, not physical modem. `modem 14` means ttyUSB58, not a specific device.
- **`AT+CNUM` usually returns empty** — most carriers don't program MSISDN. Phone numbers come from `sims` table inventory.
- **Daemon modem cache is static** — built once at startup. Restart daemon after plugging/unplugging modems: `systemctl restart sms-daemon`
- **"Offline" SIM usually means ICCID mismatch** — physical SIM doesn't match inventory, not a hardware failure.
- **USB hub at 5-tier max** — ~71 of 95 modems enumerate. Remaining fail due to USB topology/power limits.
