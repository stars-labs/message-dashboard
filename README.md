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

```
Orange Pi  (EHCI usb1, USB 2.0 480M)
└── Juyoc 10-port hub  ["small hub", 1-1]
     └── Juyoc 100-port hub-1  [1200W, MTT, 1-1.3 / 1-1.4]
          ├── sub-hub 1-1.3.1.x  →  EC20 × ~15
          ├── sub-hub 1-1.3.3.x  →  EC20 × ~10
          ├── sub-hub 1-1.3.4.x  →  EC20 × ~10
          ├── sub-hub 1-1.4.1.x  →  EC20 × ~16
          └── sub-hub 1-1.4.2.x  →  EC20 × ~16
```

> All modems run on **Bus 001 (EHCI, USB 2.0)**. The xHCI controllers (Bus 005/006) are intentionally unused — EC20 is USB 2.0 only, and xHCI exhausts per-device context memory at scale (`error -12`, ENOMEM).
> USB path format: `1-1.A.B.C.D` = Bus1 → small-hub port A → big-hub port B → sub-hub port C → modem port D.
> Full SIM ↔ IMEI ↔ USB path table: [`sim-ec20-usb-location.md`](sim-ec20-usb-location.md)

---

### Target Setup — Adding Hub-2 (~120+ modems)

```
Orange Pi  (EHCI usb1, USB 2.0 480M)
└── Juyoc 10-port hub  ["small hub", 1-1]
     ├── Port X → Juyoc 100-port hub-1  [1200W, existing]
     │             └── ~50 EC20 modems  (half of current)
     └── Port Y → Juyoc 100-port hub-2  [1200W, NEW]
                   └── ~50 EC20 modems  (moved from hub-1)
```

---

### Expansion Plan: Adding Hub-2

**Why split across two hubs**: the USB bus has a hard 127-address limit. Each EC20 consumes ~5 addresses (4 interfaces + device node), so 67 modems already uses ~400+ addresses across hubs and sub-hubs. Splitting into two subtrees on different small-hub ports doesn't extend the bus limit, but reduces congestion per subtree and makes it easier to later move hub-2 to `usb3` (a second EHCI controller) to truly double capacity.

#### Pre-checks (before touching hardware)

1. **Confirm small hub has a free port** — currently ports 3 and 4 are used (`1-1.3`, `1-1.4`). Check physically and via:
   ```bash
   ssh root@10.171.150.102 'lsusb -t | head -10'
   ```

2. **Confirm hub-2 is the same Juyoc 1200W MTT model** (VID `1a40:0201`). MTT (Multi-Transaction Translator) is required — a non-MTT hub serialises all USB 2.0 traffic through one TT, which destroys throughput with 50+ modems.

3. **Check current USB address count**:
   ```bash
   ssh root@10.171.150.102 'lsusb | wc -l'
   # Each EC20 = 5 lines; hubs = 1 line each. Total / 5 ≈ modem count.
   ```

#### Migration steps

| Step | Action | Command |
|------|--------|---------|
| 1 | Stop daemon to prevent partial state | `systemctl stop sms-daemon` |
| 2 | Plug hub-2 into a free port on the small hub. Power on, leave empty | — |
| 3 | Verify hub-2 enumerates | `lsusb \| grep 1a40` |
| 4 | Move modems — unplug **entire sub-hub groups** from hub-1 into hub-2 (e.g. move all modems on `1-1.3.3` and `1-1.3.4` groups together, keeping cables tidy) | — |
| 5 | Start daemon | `systemctl start sms-daemon` |
| 6 | Verify online count increased | `journalctl -u sms-daemon -f` |
| 7 | Re-scan IMEI↔USB mapping to regenerate location table | stop daemon → run AT+CGSN scan → start daemon |

> **Move by sub-hub groups, not individual modems** — each small 4-port sub-hub and its modems is one physical bundle. Moving a whole group keeps the wiring tidy and the location table easy to reconstruct.

#### Risks

| Risk | Mitigation |
|------|-----------|
| Still hitting 127-address bus limit after split | If so, move hub-2's cable from the small hub to `usb3` (second EHCI controller on Orange Pi) — this puts hub-2 on a completely separate bus with its own 127-address space |
| ttyUSB numbers reshuffle after replug | Expected and harmless — USB path (`1-1.x.x.x.x`) is the stable identifier; ttyUSB is volatile per-boot |
| Queued messages lost during modem move | Stop daemon first (step 1); local SQLite queue survives daemon restarts |
| hub-2 is non-MTT | Check `lsusb -v \| grep -i "transaction translator"` before installing — non-MTT will cause severe slowdown |

## Key Design Decisions

- **AT commands over ModemManager**: 1-5ms vs 50-500ms per operation, essential for 100+ modems
- **Manual refresh over WebSocket**: Eliminates persistent connection costs on Cloudflare
- **D1 over external DB**: SQLite at edge, zero cold start, global replication
- **NixOS over traditional Linux**: Declarative, reproducible Orange Pi configuration
- **Local SQLite queue**: Daemon queues messages locally, uploads in batches (10-100) to handle network interruptions
