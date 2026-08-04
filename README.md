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

## Hardware / USB Topology

### Current Setup (~67 modems active)

The 100-port hub is internally divided into 5 independent USB blocks, each connected by a separate cable to the intermediate hubs under the small hub.

```
Orange Pi  (EHCI usb1, USB 2.0 480M)
└── 1-1   Juyoc small hub (4-port)
     ├── 1-1.2  4-port intermediate hub  [currently EMPTY]
     ├── 1-1.3  4-port intermediate hub
     │    ├── 1-1.3.1  ← hub-1 cable 1  (7-port MTT)
     │    │    ├── 1-1.3.1.2.x  EC20 × 4
     │    │    ├── 1-1.3.1.3.x  EC20 × 4
     │    │    ├── 1-1.3.1.4.x  EC20 × 3
     │    │    ├── 1-1.3.1.5.x  EC20 × 2
     │    │    └── 1-1.3.1.6.x  EC20 × 3
     │    ├── 1-1.3.2  [EMPTY]
     │    ├── 1-1.3.3  ← hub-1 cable 2  (7-port MTT)
     │    │    ├── 1-1.3.3.2.x  EC20 × 3
     │    │    ├── 1-1.3.3.3.x  EC20 × 1
     │    │    ├── 1-1.3.3.4.x  EC20 × 1
     │    │    ├── 1-1.3.3.5.x  EC20 × 2
     │    │    └── 1-1.3.3.6.x  EC20 × 3
     │    └── 1-1.3.4  ← hub-1 cable 3  (7-port MTT)
     │         ├── 1-1.3.4.2.x  EC20 × 3
     │         ├── 1-1.3.4.3.x  EC20 × 2
     │         ├── 1-1.3.4.4.x  EC20 × 1
     │         ├── 1-1.3.4.5.x  EC20 × 2
     │         └── 1-1.3.4.6.x  EC20 × 4
     └── 1-1.4  4-port intermediate hub
          ├── 1-1.4.1  [EMPTY]
          ├── 1-1.4.2  ← hub-1 cables 4+5  (7-port MTT)
          │    ├── 1-1.4.2.2.x  EC20 × 4
          │    ├── 1-1.4.2.3.x  EC20 × 3
          │    ├── 1-1.4.2.4.x  EC20 × 2
          │    ├── 1-1.4.2.5.x  EC20 × 3
          │    └── 1-1.4.2.6.x  EC20 × 3
          ├── 1-1.4.3  [EMPTY]
          └── 1-1.4.4  [EMPTY]
```

> All modems run on **Bus 001 (EHCI, USB 2.0)**. The xHCI controllers (Bus 005/006) are intentionally unused — EC20 is USB 2.0 only, and xHCI exhausts per-device context memory at scale (`error -12`, ENOMEM).
> USB path format: `1-1.A.B.C.D` = Bus1 → small-hub port A → intermediate-hub port B → big-hub-block port C → modem port D.
> Full SIM ↔ IMEI ↔ USB path table: [`sim-ec20-usb-location.md`](sim-ec20-usb-location.md)

---

### Target Setup — Adding Hub-2 (same usb1 bus)

Hub-2's 5 cables slot into the 7 currently empty ports across the existing intermediate hubs. Both hub-1 and hub-2 share the same `usb1` bus (127-address limit shared).

```
Orange Pi  (EHCI usb1, USB 2.0 480M)
└── 1-1   Juyoc small hub (4-port)
     ├── 1-1.2  4-port intermediate hub
     │    ├── 1-1.2.1  ← hub-2 cable 1  (7-port MTT)
     │    ├── 1-1.2.2  ← hub-2 cable 2  (7-port MTT)
     │    ├── 1-1.2.3  ← hub-2 cable 3  (7-port MTT)
     │    └── 1-1.2.4  ← hub-2 cable 4  (7-port MTT)
     ├── 1-1.3  4-port intermediate hub
     │    ├── 1-1.3.1  ← hub-1 cable 1  (existing)
     │    ├── 1-1.3.2  ← hub-2 cable 5  (7-port MTT)
     │    ├── 1-1.3.3  ← hub-1 cable 2  (existing)
     │    └── 1-1.3.4  ← hub-1 cable 3  (existing)
     └── 1-1.4  4-port intermediate hub
          ├── 1-1.4.1  [still free — future usb3 migration anchor]
          ├── 1-1.4.2  ← hub-1 cables 4+5  (existing)
          ├── 1-1.4.3  [still free]
          └── 1-1.4.4  [still free]
```

> ⚠️ **Address budget**: Bus 001 currently has ~76 device nodes, limit is 127. Hub-2 tree adds ~6 hub nodes + ~5 per new EC20. Headroom for ~8-9 additional modems before hitting the bus limit. To truly scale beyond this, move hub-2 to `usb3` (separate EHCI controller, independent 127-address space) once a second small hub is available.

---

### Migration Steps

**Pre-check** (verify before touching hardware):
```bash
# Confirm available ports
ssh root@10.171.150.102 'lsusb -t | grep "Bus 001" -A 8'
# Current bus address usage (limit = 127)
ssh root@10.171.150.102 'lsusb | grep "Bus 001" | wc -l'
```

| Step | Action | Command |
|------|--------|---------|
| 1 | Stop daemon | `systemctl stop sms-daemon` |
| 2 | Connect hub-2 cables: 4 into `1-1.2` ports 1-4, 1 into `1-1.3.2`. Power on, leave modems unplugged | — |
| 3 | Verify hub-2 enumerates (5 new MTT hubs should appear) | `lsusb \| grep 1a40` |
| 4 | Move modems from hub-1 to hub-2 — **move entire 7-port block groups**, not individual modems | — |
| 5 | Start daemon | `systemctl start sms-daemon` |
| 6 | Verify online count | `journalctl -u sms-daemon -f` |
| 7 | Re-scan IMEI↔USB to regenerate `sim-ec20-usb-location.md` | stop daemon → AT+CGSN scan → start daemon |

#### Risks

| Risk | Mitigation |
|------|-----------|
| Bus 001 hits 127-address limit after adding hub-2 | Expected at ~8-9 new modems. Next step: move hub-2 to `usb3` (second EHCI, independent bus) |
| ttyUSB numbers reshuffle | Expected — use USB path as stable ID, not ttyUSB |
| Queued messages lost during move | Stop daemon first; local SQLite queue persists across restarts |
| hub-2 is non-MTT | Verify with `lsusb -v \| grep -i translator` — non-MTT serialises all traffic, kills throughput |

## Key Design Decisions

- **AT commands over ModemManager**: 1-5ms vs 50-500ms per operation, essential for 100+ modems
- **Manual refresh over WebSocket**: Eliminates persistent connection costs on Cloudflare
- **D1 over external DB**: SQLite at edge, zero cold start, global replication
- **NixOS over traditional Linux**: Declarative, reproducible Orange Pi configuration
- **Local SQLite queue**: Daemon queues messages locally, uploads in batches (10-100) to handle network interruptions
