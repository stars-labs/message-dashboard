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
│  Worker Pool (16)    │ Key │  Keyword Tagging    │     │  Code Extraction │
└──────────────────────┘     └─────────────────────┘     └──────────────────┘
```

**Daemon** collects SMS from USB modems via direct AT commands (with D-Bus/ModemManager fallback), batches them, and uploads to the API. It also syncs device status, signal quality, and handles outbound SMS sending.

**API** runs on Cloudflare Workers with a D1 (SQLite) database. Handles device registration, message storage, keyword tagging, and verification code extraction. Auth0 JWT for users, API key for daemon.

**Frontend** is a Svelte 5 SPA served from the same Worker. Shows device list, signal strength, messages with verification code extraction, ICCID mappings, and keyword configuration.

## Project Structure

```
├── orange-pi-daemon/       # Rust daemon (Tokio async, ~8800 LOC)
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
nix develop --command dev-server restart
# Frontend: http://localhost:8080; Worker API: http://localhost:8787
```

### Rust Daemon

```bash
cd orange-pi-daemon
cargo build --release
RUST_LOG=debug SMS_API_URL=https://sexy.itoken.world SMS_API_KEY=<key> cargo run
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
| `modems` | Hardware plus current signal, connection, detected ICCID, and USB state (PK: equipment_id/IMEI) |
| `sims` | SIM cards (PK: iccid), FK to modems |
| `messages` | SMS content with extracted verification codes |
| `daemon_health` | Heartbeat monitoring |
| `device_view` | Primary SIM-centric read view joined by assigned IMEI |

```bash
# Query remote DB
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"
```

## Auth

- **Users → Frontend**: Auth0 JWT with fail-closed RBAC (`sms-viewer`/`sms-admin`)
- **Daemon → API**: API key (stored in SOPS secrets, set via `wrangler secret put API_KEY`)

## Hardware / USB Topology

### USB Controllers (buses) on the Orange Pi

A **bus = one USB host controller**, and the 127-address limit applies **per bus**. Each USB 2.0 physical socket is served by a paired EHCI (high-speed) + OHCI (low/full-speed) controller:

| Bus | Hardware address | Controller | Physical socket |
|-----|-----------------|-----------|-----------------|
| `usb1` | `fc800000.usb` | EHCI 480M | **Socket A** — small hub + 6 cables, 66 modems |
| `usb2` | `fc840000.usb` | OHCI 12M | Socket A (low-speed companion) |
| `usb3` | `fc880000.usb` | EHCI 480M | **Socket B** — 1 cable direct, 11 modems |
| `usb4` | `fc8c0000.usb` | OHCI 12M | Socket B (low-speed companion) |
| `usb5` (480M) / `usb6` (5000M) | `xhci-hcd.5.auto` | xHCI | USB 3.0 socket — intentionally unused |

> xHCI is avoided: EC20 is USB 2.0 only, so 5Gbps gives zero benefit, and xHCI exhausts per-device context memory at scale (`error -12`, ENOMEM).

**Two buses per socket, for two different reasons — don't conflate them.** EHCI speaks only High-Speed, so Full/Low-Speed devices on the same pins need a *companion* OHCI controller: `usb1`+`usb2` are genuinely **two separate controllers**. xHCI handles all speeds in one controller but still registers **two buses** — `usb5` and `usb6` share the single instance `xhci-hcd.5.auto` — because the USB-2 pairs and the SuperSpeed pairs are physically distinct wire pairs.

**Every root hub exposes exactly 1 port** (`maxchild=1`, verified 2026-08-06). One physical socket therefore accepts exactly one upstream cable; fanning out more cables requires a small hub, at a cost of 4 addresses.

Socket↔bus pairing is confirmed two ways: device-tree PHY phandles (controllers sharing a phandle share a connector) and empirically — devices plugged into socket B enumerate on `usb3`.

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

### Current State (verified 2026-08-06) — both EHCI buses in use, 77 modems

The socket-B migration below has been **partially executed**: bus1 dropped from 9 cables to 6, and one cable now runs direct off socket B. Bus 001 is no longer at 127/127.

| Bus | Addresses /127 | Hub chips | EC20 | Cables | Signal-error lines this boot |
|-----|---------------|-----------|------|--------|------------------------------|
| **001** | **107** | 40 (4 small hub + 6×6) | **66** | 6, behind small hub | **246** |
| **003** | **18** | 6 (1 cable, direct) | **11** | 1 | **0** |
| 005 / 006 | 2 / 2 | 1× Genesys `05e3` | 0 | — | — |

Over-current events: **0**. Against a 95-SIM inventory, 77 online leaves **18 unplaced**.

```
Orange Pi socket A → usb1 (EHCI)          Orange Pi socket B → usb3 (EHCI)
└── 1-1    small hub, upstream chip        └── 3-1    MTT block → 11 EC20
     ├── 1-1.2  ├── 1-1.2.2  → 11 EC20         (no small hub — direct connect,
     │          └── 1-1.2.3  → 11 EC20          costs only 7 addresses total)
     ├── 1-1.3  ├── 1-1.3.2  → 11 EC20
     │          └── 1-1.3.3  → 11 EC20
     └── 1-1.4  ├── 1-1.4.1  → 11 EC20
                └── 1-1.4.2  → 11 EC20
```

**The occupancy pattern is perfectly uniform, and that is the most informative finding.** Every one of the 7 cables holds exactly 11 modems, and within every cable the 5 leaf hubs hold `2, 2, 2, 3, 2` modems across their 4 sockets each. **Zero leaf hubs are empty** — there are no wasted hub addresses left to reclaim.

- **Practical yield is ~11 modems per cable, not 20.** Sockets sit at ~55% occupancy everywhere, uniformly — which is the signature of a *physical* constraint (module bodies wider than the socket pitch, so adjacent sockets can't both be used), not of a missing-hardware or enumeration problem. **This is inference from the uniform pattern, not a confirmed measurement** — worth verifying by eye at the rack.
- **Bus 001 is address-bound, not socket-bound.** 6 cables = 120 sockets with only 66 filled, but just 20 addresses remain, so **54 sockets are permanently unreachable on this bus**. Its ceiling is 86.
- **Adding a 7th cable to bus1 would be self-defeating**: 6 more addresses for hub chips leaves 14 for modems, and at the observed 11-per-cable yield you gain ~11 while losing headroom. Expand on bus3 instead — it has 109 free addresses and zero errors.
- **`device not accepting address` appears on bus1 while 20 addresses are still free** — a live confirmation that this message never indicates exhaustion (see failure modes below).
- **Unexplained:** 306 `ttyUSB` nodes vs 308 expected (77 × 4). Two interfaces missing; not chased down.

> USB path format: `1-1.A.B.C.D` = Bus1 → small-hub chip port A → MTT block port B → leaf sub-hub port C → modem port D.
> Full SIM ↔ IMEI ↔ USB path table: [`sim-ec20-usb-location.md`](sim-ec20-usb-location.md)

### Two distinct failure modes — don't conflate them

**A. Signal integrity (the problem today).** Deep hub tiers produce protocol errors that kill whole blocks:

```
usb 1-1.4.2: device descriptor read/8, error -71     ← the MTT chip itself
usb 1-1.4-port2: unable to enumerate USB device      ← whole block dropped, 20 sockets lost
usb 1-1.3.2.4-port4: unable to enumerate USB device
```

Measured error counts (2026-08-05 boot): **79× `error -71` (EPROTO)**, **36× `error -32` (EPIPE)**, **0× `error -12` (ENOMEM)**.

**Blast radius = path segment count.** `1-1.4-port1` (2 segments) is a small-hub port, so an entire 20-socket block drops at once; `1-1.3.3.4-port1` (4 segments) is a leaf-hub port and costs a single modem. Repeated retries on one port (39× observed) mean an *intermittent* fault, not a hard break.

**A natural A/B pair exists as of 2026-08-06:** bus1 logs **246** matching error lines, bus3 logs **0** — same filter, and it demonstrably matches on bus1, so bus3's zero is genuine absence rather than a broken filter. One untested hypothesis for the difference is the passive USB extension cables used on bus1 to relieve socket crowding (voltage drop during LTE TX bursts → module brownout → re-enumeration). A passive cable adds no tier and consumes no address, so it cannot affect the address budget — only signal quality. **Whether bus3 is free of extension cables has not been confirmed; establish that before drawing any conclusion.** To test directly: pick a port that repeatedly logs `Cannot enable`, remove its extension cable, plug the module straight in, restart the daemon, and see whether that socket stabilises.

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

**B. Address exhaustion.** On 2026-08-05 bus1 hit it exactly: every devnum 1–127 allocated, zero gaps, nothing new able to enumerate regardless of signal quality. **Relieved as of 2026-08-06** by moving 3 cables off bus1 — it now sits at 107/127.

The address field in a USB token packet is **7 bits** → 128 values, and **address 0 is reserved** for devices that have not yet been assigned one, leaving 127 usable. Hubs are USB devices and consume addresses from the same pool — verified here, where every hub chip holds its own devnum. Reference: [USB in a NutShell, Ch. 3](https://www.beyondlogic.org/usbnutshell/usb3.shtml).

**Never diagnose exhaustion from error text** — it prints no distinctive message. Count instead: `lsusb | awk '{print $2}' | sort | uniq -c`. Bus1 currently logs `device not accepting address` with 20 addresses free, which proves the point.

---

### Why two 100-port hubs on one bus cannot work

Each 100-port hub costs **30 addresses** of pure hub overhead (5 blocks × 6 chips). Putting both on `usb1`:

```
1 root + 4 (small hub) + 60 (two 100-port hubs, all 10 cables) = 65 addresses
127 − 65 = 62 modem slots      ← fewer than the 68 that were online with 9 cables
```

**More cables actively costs you modems.** Splitting across two hubs on the same bus is self-defeating: the 200 sockets are unreachable because hub chips eat the address budget.

### Remaining Work — place the last 18 modems on Bus 003

77 of 95 SIMs are online. Bus1 is address-bound at a ceiling of 86 and carries all 246 signal errors, so **add nothing to it**. Bus3 has 109 free addresses and zero errors, but its single cable has only ~9 free sockets, so a second cable is needed — and since the root hub has just 1 port, that means inserting the small hub on socket B:

```
Socket A → usb1 (EHCI)              Socket B → usb3 (EHCI)
└── small hub    (4 addr)           └── small hub   (4 addr)
     └── 6 cables (36 addr)              └── 2–3 cables (12–18 addr)
          └── 66 EC20 today                   └── 18 more EC20
             107/127, ceiling 86                  ≤ 56/127, lots of headroom
```

At the **observed** yield of ~11 modems per cable (not the theoretical 20), reaching 95 needs 2 more cables on bus3; a 3rd gives margin. Re-seating the existing cable under the new small hub re-enumerates everything on bus3 — restart the daemon afterwards.

---

### Migration Steps

> **⚠️ OLD IP** — `10.171.150.102` below is the pre-relocation office address,
> pending change (noted 2026-08-26). Source of truth: `docs/deployment.md#orange-pi-daemon`.

**Pre-check**:
```bash
# Bus 001 address usage (limit = 127)
# Address usage PER BUS — both EHCI buses carry modems now, never report one number alone
ssh root@10.171.150.102 "lsusb | awk '{print \$2}' | sort | uniq -c"
# Hub vs modem split on a given bus
ssh root@10.171.150.102 'echo "bus3 hubs: $(lsusb | grep "Bus 003" | grep -c 1a40)  modems: $(lsusb | grep -c 2c7c)"'
# Enumeration failures
ssh root@10.171.150.102 'dmesg | grep -iE "unable to enumerate|not accepting address" | tail'
```

Steps 1–4 were **completed on 2026-08-06** (3 cables moved off bus1, one now direct on socket B, 66 + 11 = 77 online). Remaining work is steps 2′–7 for the last 18 modems:

| Step | Action | Command |
|------|--------|---------|
| 1 | Stop daemon | `systemctl stop sms-daemon` |
| 2′ | Insert small hub on socket B, move the existing `3-1` cable under it, add 2 more cables | — |
| 3 | Verify all cables appear on Bus 003 | `lsusb -t \| sed -n '/Bus 003/,/Bus 004/p'` |
| 4 | Confirm per-bus address usage | `lsusb \| awk '{print $2}' \| sort \| uniq -c` |
| 5 | Start daemon (rebuilds the initial cache; 60-second re-discovery then resumes) | `systemctl start sms-daemon` |
| 6 | Verify online count | `journalctl -u sms-daemon -f` |
| 7 | Re-scan IMEI↔USB to regenerate `sim-ec20-usb-location.md` | stop daemon → AT+CGSN scan → start daemon |

#### Risks

| Risk | Mitigation |
|------|-----------|
| `usb3` root hub has only 1 port | A small hub (4 addresses) is mandatory for a 2nd cable; one cable direct costs only 7 addresses total |
| Re-seating the existing `3-1` cable re-enumerates its 11 working modems | Do it in the same maintenance window as the new cables; restart the daemon once at the end |
| ttyUSB numbers reshuffle after any replug | Expected — USB path is the stable ID, ttyUSB is volatile per boot |
| A modem never enumerates a ttyUSB path | The 60-second re-discovery cannot see it; fix the hardware path and restart only if state does not recover |
| Queued messages lost during move | Stop daemon first; the local SQLite queue persists across restarts |
| hub-2 is non-MTT | Verify with `lsusb -v \| grep -i translator` — non-MTT serialises all traffic |

## Key Design Decisions

- **AT commands over ModemManager**: 1-5ms vs 50-500ms per operation, essential for 100+ modems
- **Request/refresh over persistent streaming**: Eliminates WebSocket/SSE connection costs on Cloudflare
- **D1 over external DB**: SQLite at edge, zero cold start, global replication
- **NixOS over traditional Linux**: Declarative, reproducible Orange Pi configuration
- **Local SQLite queue**: Daemon queues messages locally, uploads in batches (10-100) to handle network interruptions
