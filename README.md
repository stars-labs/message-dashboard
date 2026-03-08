# SMS Dashboard

A distributed SMS management system for 100+ USB modems running on Orange Pi hardware, with a web dashboard hosted on Cloudflare.

## Architecture

```
Orange Pi 5+ (ARM64, NixOS)          Cloudflare                    Browser
┌──────────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│  Rust Daemon v8.0.0  │     │  Workers (JS)       │     │  Svelte 5        │
│                      │     │                     │     │  + TailwindCSS   │
│  AT Commands / D-Bus │────▶│  D1 Database        │◀────│                  │
│  100+ USB Modems     │ API │  Auth0 + RBAC       │ JWT │  Manual Refresh  │
│  Worker Pool (6)     │ Key │  Keyword Tagging    │     │  Code Extraction │
└──────────────────────┘     └─────────────────────┘     └──────────────────┘
```

**Daemon** collects SMS from USB modems via direct AT commands (with D-Bus/ModemManager fallback), batches them, and uploads to the API. It also syncs device status, signal quality, and handles outbound SMS sending.

**API** runs on Cloudflare Workers with a D1 (SQLite) database. Handles device registration, message storage, keyword tagging, and verification code extraction. Auth0 JWT for users, API key for daemon.

**Frontend** is a Svelte 5 SPA served from the same Worker. Shows device list, signal strength, messages with verification code extraction, ICCID mappings, and keyword configuration.

## Project Structure

```
├── orange-pi-daemon/       # Rust daemon (Tokio async, ~5700 LOC)
│   └── src/
│       ├── main.rs         # Multi-task event loop
│       ├── at_modem.rs     # Direct AT command interface
│       ├── modem_manager.rs # ModemManager orchestration
│       ├── dbus_client.rs  # Native D-Bus via zbus
│       ├── api_client.rs   # HTTP uploads to Workers API
│       ├── sms_sender.rs   # Outbound SMS via D-Bus
│       ├── worker_pool.rs  # Concurrent modem reader pool
│       ├── sync_manager.rs # Full/incremental sync logic
│       ├── signal_cache.rs # 30s TTL signal cache
│       ├── message_store.rs # Local SQLite queue
│       └── retry_manager.rs # Upload retry with backoff
│
├── sms-dashboard/
│   ├── client/             # Svelte 5 frontend
│   │   ├── App.svelte      # Main app
│   │   └── lib/            # Components + utilities
│   ├── server/             # Cloudflare Workers backend
│   │   ├── index.js        # SimpleRouter + middleware chain
│   │   ├── handlers/       # API endpoint handlers
│   │   ├── api/            # Route modules (keywords)
│   │   └── middleware/     # CORS, Auth0, RBAC
│   ├── migrations/         # D1 SQL migrations
│   ├── config/             # Auth0 role config
│   └── wrangler.toml       # Cloudflare Workers config
│
├── nixos-config/           # NixOS deployment
│   ├── orange-pi/          # Orange Pi system config
│   ├── modules/            # sms-daemon.nix service module
│   └── secrets/            # SOPS-encrypted secrets
│
├── ansible/                # Deployment automation
├── sql/                    # Database maintenance queries
├── docs/                   # Documentation
├── flake.nix               # Nix flake (builds daemon + NixOS config)
└── .sops.yaml              # SOPS encryption config
```

## Quick Start

### Frontend + API (local dev)

```bash
cd sms-dashboard
bun install
bun run dev          # Vite dev server on :5173
bun run dev:api      # Wrangler local API
```

### Rust Daemon

```bash
cd orange-pi-daemon
cargo build --release
RUST_LOG=debug SMS_API_URL=https://sexy.qzz.io SMS_API_KEY=<key> cargo run
```

### Deploy

```bash
# Frontend + API → Cloudflare
cd sms-dashboard && bun run deploy

# Daemon + NixOS → Orange Pi
nixos-rebuild switch --flake .#orange-pi \
  --target-host root@<orange-pi-ip> \
  --build-host root@<orange-pi-ip> \
  --use-substitutes --impure
```

## Database

Cloudflare D1 with normalized 3NF schema:

| Table | Purpose |
|-------|---------|
| `modems` | Hardware devices (PK: equipment_id/IMEI) |
| `sims` | SIM cards (PK: iccid), FK to modems |
| `modem_state` | Signal strength, connection status |
| `messages` | SMS content with extracted verification codes |
| `daemon_health` | Heartbeat monitoring |
| `device_view` | Backward-compat view joining all tables |

```bash
# Query remote DB
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"
```

## Auth

- **Users → Frontend**: Auth0 JWT with RBAC (`sms` role required)
- **Daemon → API**: API key (stored in SOPS secrets, set via `wrangler secret put API_KEY`)

## Key Design Decisions

- **AT commands over ModemManager**: 1-5ms vs 50-500ms per operation, essential for 100+ modems
- **Manual refresh over WebSocket**: Eliminates persistent connection costs on Cloudflare
- **D1 over external DB**: SQLite at edge, zero cold start, global replication
- **NixOS over traditional Linux**: Declarative, reproducible Orange Pi configuration
- **Local SQLite queue**: Daemon queues messages locally, uploads in batches (10-100) to handle network interruptions
