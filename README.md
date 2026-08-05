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

### USB Controllers (buses) on the Orange Pi

A **bus = one USB host controller**, and the 127-address limit applies **per bus**. Each USB 2.0 physical socket is served by a paired EHCI (high-speed) + OHCI (low/full-speed) controller:

| Bus | Hardware address | Controller | Physical socket |
|-----|-----------------|-----------|-----------------|
| `usb1` | `fc800000.usb` | EHCI 480M | **Socket A** — hub-1 + hub-2 (saturated) |
| `usb2` | `fc840000.usb` | OHCI 12M | Socket A (low-speed half) |
| `usb3` | `fc880000.usb` | EHCI 480M | **Socket B — FREE, expansion target** |
| `usb4` | `fc8c0000.usb` | OHCI 12M | Socket B (low-speed half) |
| `usb5`/`usb6` | `fc400000.usb` | xHCI | USB 3.0 socket — intentionally unused |

> xHCI is avoided: EC20 is USB 2.0 only, so 5Gbps gives zero benefit, and xHCI exhausts per-device context memory at scale (`error -12`, ENOMEM).
> The EHCI/OHCI socket pairing above is inferred from the standard Rockchip layout — confirm by plugging a device in and checking which bus it appears on.

### Hub Internals — sockets vs. chips

The number on the label is the count of **external sockets you can plug into**. Internally each enclosure is a **cascade of Terminus hub chips**, and *every chip costs one USB address before a single modem is plugged in*. Sockets are what you see; chips are what the kernel counts.

**"100-port" big hub** — 5 independent blocks, one cable each:

```
1 block (1 cable) = 1× 1a40:0201  7-port MTT chip
                     └── MTT ports 2,3,4,5,6 → 5× 1a40:0101 4-port leaf chips
                          └── 5 × 4 = 20 external sockets
```

| | Sockets | Chips (= addresses) |
|---|---------|--------------------|
| Per block (per cable) | **20** | 1 MTT + 5 leaf = **6** |
| Per 100-port hub (5 blocks) | **100** | **30** |

**"10-port" small hub** — 4× `1a40:0101` 4-port chips, verified port wiring:

| Chip | Downstream ports used | External sockets exposed |
|------|----------------------|------------------------|
| `1-1` (upstream) | 2, 3, 4 → the 3 chips below | 0 |
| `1-1.2` | 1, 2, 3, 4 (full) | 4 |
| `1-1.3` | 1, 2, 3, 4 (full) | 4 |
| `1-1.4` | 1 | 2 |
| | | **10 sockets, 4 addresses** |

**An EC20 costs exactly 1 address** — its 5 USB interfaces (4× `option` + 1× `qmi_wwan`) share a single device address.

> **Sockets are never the constraint — addresses are.** Two 100-port hubs expose 200 sockets, but their 60 chip-addresses plus the small hub leave only `127 − 1 − 64 = 62` addresses for modems.

### Current State (2026-08-05) — Bus 001 SATURATED

```
Bus 001 = 127 / 127 addresses  ← HARD LIMIT REACHED, verified exactly
    1   root hub
    4   small-hub chips        (the "10-port" enclosure)
    9   MTT block chips        ← only 9 of 10 cables enumerated
   45   leaf 4-port chips      (9 blocks × 5)
   68   EC20 modems            ← 127 − 59 hub/root addresses = 68 online
```

> **One entire cable failed to enumerate.** Two 100-port hubs = 10 cables, but only 9 MTT blocks appear. The 10th block (`1-1.4.2`) died on a *signal-integrity* error, not address exhaustion — see the two distinct failure modes below. Its 20 sockets are unusable, so every modem on it is invisible to the host.

```
Orange Pi socket A → usb1 (EHCI)
└── 1-1   "10-port" small hub, upstream chip
     │      (ports 2,3,4 → internal chips; no external socket)
     ├── 1-1.2  chip — 4 external sockets, ALL occupied
     │    ├── 1-1.2.1  MTT block → 11 EC20
     │    ├── 1-1.2.2  MTT block →  9 EC20
     │    ├── 1-1.2.3  MTT block →  8 EC20
     │    └── 1-1.2.4  MTT block →  6 EC20   (2 empty leaf chips)
     ├── 1-1.3  chip — 4 external sockets, ALL occupied
     │    ├── 1-1.3.1  MTT block →  0 EC20   ← 6 addresses wasted, 20 sockets idle
     │    ├── 1-1.3.2  MTT block →  8 EC20
     │    ├── 1-1.3.3  MTT block →  6 EC20   (2 empty leaf chips)
     │    └── 1-1.3.4  MTT block →  9 EC20
     └── 1-1.4  chip — 2 external sockets
          ├── 1-1.4.1  MTT block → 11 EC20
          └── (port 2)  ← the ONLY free socket on the small hub
```

Cable accounting: 9 of the small hub's 10 sockets are occupied, giving 9 MTT blocks (4+4+1). Two 100-port hubs should supply 10 cables — the 10th either isn't plugged in or failed to enumerate.

> USB path format: `1-1.A.B.C.D` = Bus1 → small-hub chip port A → MTT block port B → leaf sub-hub port C → modem port D.
> Full SIM ↔ IMEI ↔ USB path table: [`sim-ec20-usb-location.md`](sim-ec20-usb-location.md)

### Two distinct failure modes — don't conflate them

**A. Signal integrity (the problem today).** Deep hub tiers produce protocol errors that kill whole blocks:

```
usb 1-1.4.2: device descriptor read/8, error -71     ← the MTT chip itself
usb 1-1.4-port2: unable to enumerate USB device      ← whole block dropped, 20 sockets lost
usb 1-1.3.2.4-port4: unable to enumerate USB device
```

Measured error counts: **79× `error -71` (EPROTO)**, **36× `error -32` (EPIPE)**, **0× `error -12` (ENOMEM)**.

Two proofs this is *not* address exhaustion:
- `device not accepting address N` is only printed *after* the kernel has already allocated address N and sent `SET_ADDRESS` — an address was available.
- On real devnum exhaustion, `choose_devnum()` in `drivers/usb/core/hub.c` finds no free bit, `devnum` stays 0, and `hub_port_init` bails out early with `-ENOTCONN`. That path never prints "not accepting address".

Tier depth is the likely driver — every level adds propagation delay and jitter:

```
tier 1  root hub              tier 4  1-1.2.1      MTT chip
tier 2  1-1    small-hub up   tier 5  1-1.2.1.5    leaf chip
tier 3  1-1.2  small-hub int  tier 6  1-1.2.1.5.2  EC20
```

USB 2.0 permits 7 tiers (root + 5 external hubs + device). This chain uses **4 external hub levels — legal, but close to the limit**.

**B. Address exhaustion (the future wall).** Verified by reading every `devnum` in sysfs: **devnums 1–127 are all allocated, zero gaps**. Nothing new can enumerate on this bus from now on, regardless of signal quality.

The address field in a USB token packet is **7 bits** → 128 values, and **address 0 is reserved** for devices that have not yet been assigned one, leaving 127 usable. Hubs are USB devices and consume addresses from the same pool — verified here, where all 58 hub chips hold their own devnum. Reference: [USB in a NutShell, Ch. 3](https://www.beyondlogic.org/usbnutshell/usb3.shtml).

---

### Why two 100-port hubs on one bus cannot work

Each 100-port hub costs **30 addresses** of pure hub overhead (5 blocks × 6 chips). Putting both on `usb1`:

```
1 root + 4 (small hub) + 60 (two 100-port hubs, all 10 cables) = 65 addresses
127 − 65 = 62 modem slots

Today only 9 of 10 cables enumerated, so: 1 + 4 + 54 = 59  →  68 modems online
```

**More cables actively costs you modems.** Splitting across two hubs on the same bus is self-defeating: the 200 sockets are unreachable because hub chips eat the address budget. To exceed ~68, hub-2 must move to its own bus.

### Target Setup — hub-2 on Bus 003 (socket B)

```
Socket A → usb1 (EHCI)              Socket B → usb3 (EHCI)
└── small hub      (4 addr)         └── hub-2  (30 addr)
     └── hub-1     (30 addr)             └── up to ~96 EC20
          └── up to ~92 EC20
```

| Bus | Root + hub overhead | Modem capacity |
|-----|--------------------|----------------|
| `usb1` — small hub + hub-1 | 35 | **~92** |
| `usb3` — hub-2 | 31 | **~96** |

That covers all 95 SIMs with headroom.

**Constraint**: the `usb3` root hub has only **1 port**, so fanning out all 5 hub-2 cables needs a second small hub on socket B. Without one, plugging **a single hub-2 cable** straight into socket B still gives that block a fresh 127-address bus — **20 usable sockets for only 7 addresses** of overhead.

---

### Immediate Zero-Cost Win — reclaim wasted addresses

9 leaf sub-hubs and 1 entire MTT block are enumerated with **zero modems attached**, each still holding an address:

| Empty hub | Addresses reclaimed |
|-----------|--------------------|
| `1-1.3.1` block + its 5 empty leaf sub-hubs | 6 |
| `1-1.3.3.3`, `1-1.3.3.4` | 2 |
| `1-1.2.4.5`, `1-1.2.4.6` | 2 |

Unplugging these frees ~10 addresses → ~10 more modems can enumerate, with no new hardware.

---

### Migration Steps

**Pre-check**:
```bash
# Bus 001 address usage (limit = 127)
ssh root@10.171.150.102 'lsusb | grep -c "Bus 001"'
# Hub vs modem split
ssh root@10.171.150.102 'echo "hubs: $(lsusb | grep "Bus 001" | grep -c 1a40)  modems: $(lsusb | grep -c 2c7c)"'
# Enumeration failures
ssh root@10.171.150.102 'dmesg | grep -iE "unable to enumerate|not accepting address" | tail'
```

| Step | Action | Command |
|------|--------|---------|
| 1 | Stop daemon | `systemctl stop sms-daemon` |
| 2 | Move hub-2's cables from socket A's small hub to socket B (`usb3`) | — |
| 3 | Verify hub-2 appears on Bus 003 | `lsusb -t \| grep -A5 "Bus 003"` |
| 4 | Confirm Bus 001 address usage dropped | `lsusb \| grep -c "Bus 001"` |
| 5 | Start daemon (rebuilds its static modem cache) | `systemctl start sms-daemon` |
| 6 | Verify online count | `journalctl -u sms-daemon -f` |
| 7 | Re-scan IMEI↔USB to regenerate `sim-ec20-usb-location.md` | stop daemon → AT+CGSN scan → start daemon |

#### Risks

| Risk | Mitigation |
|------|-----------|
| `usb3` root hub has only 1 port | Needs a second small hub for all 5 cables; a single cable still yields 20 sockets on a fresh bus |
| ttyUSB numbers reshuffle after any replug | Expected — USB path is the stable ID, ttyUSB is volatile per boot |
| Daemon keeps a **static** modem cache | Always restart the daemon after any physical change |
| Queued messages lost during move | Stop daemon first; the local SQLite queue persists across restarts |
| hub-2 is non-MTT | Verify with `lsusb -v \| grep -i translator` — non-MTT serialises all traffic |

## Key Design Decisions

- **AT commands over ModemManager**: 1-5ms vs 50-500ms per operation, essential for 100+ modems
- **Manual refresh over WebSocket**: Eliminates persistent connection costs on Cloudflare
- **D1 over external DB**: SQLite at edge, zero cold start, global replication
- **NixOS over traditional Linux**: Declarative, reproducible Orange Pi configuration
- **Local SQLite queue**: Daemon queues messages locally, uploads in batches (10-100) to handle network interruptions
