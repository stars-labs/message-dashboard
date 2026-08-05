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
- **SSH over FortiClient VPN**: the tunnel's broad `10.171/16` route via `ppp0` is wrong for the Orange Pi. Before `ssh root@10.171.150.102`, add a host route through the correct gateway:
  ```sh
  sudo route add -host 10.171.150.102 10.171.121.1
  ```
  Symptom when missing: ping = 100% loss, SSH exits 255. The route persists until the VPN reconnects, so re-run it after each FortiClient reconnect.
- Sync intervals: device status every 30s, full sync every 5min (keeps under CF rate limits)

### SIM detection gotchas
- **Modem ID = USB port position**, not physical modem. `modem 14` means ttyUSB58, not a specific device.
- **`AT+CNUM` usually returns empty** — most carriers don't program MSISDN. Phone numbers come from `sims` table inventory.
- **Daemon modem cache is static** — built once at startup. Restart daemon after plugging/unplugging modems: `systemctl restart sms-daemon`
- **"Offline" SIM usually means ICCID mismatch** — physical SIM doesn't match inventory, not a hardware failure.

### USB address budget — THE binding constraint (verified 2026-08-05)

This is the foundation the whole 100-modem system rests on. **Sockets are never the limit; USB addresses are.**

**Mechanism (verified).** A USB token packet's ADDR field is **7 bits** → 128 values, and address 0 is reserved for devices that have not yet been assigned one → **127 usable addresses per bus**. Linux mirrors the protocol exactly: `DECLARE_BITMAP(devmap, 128)` in `struct usb_bus`, and `choose_devnum()` (`drivers/usb/core/hub.c`) does `find_next_zero_bit(bus->devmap, 128, ...)`, only assigning when `devnum < 128` — when full, `udev->devnum` stays 0 and enumeration fails.

- **This is a protocol limit, not a kernel policy and not a USB-2.0 quirk.** No sysctl or module param can raise it. EHCI/OHCI/xHCI are host-controller *register interfaces*, not the wire protocol — moving EHCI→xHCI does **not** buy more addresses. The only way to get more is **more host controllers (more buses)**.
- **Every hub chip costs 1 address. An EC20 costs exactly 1** — its 5 USB interfaces (4× `option` + 1× `qmi_wwan`) share one device address.

**Measured hub cost** — the label is sockets, the cost is chips:

| Hardware (label) | Internal chips | Addresses | Sockets |
|---|---|---|---|
| "10-port" small hub | 4× `1a40:0101` cascaded: `1-1` → `1-1.2`/`1-1.3`/`1-1.4` | 4 | 10 |
| "100-port" hub — **per cable** | 1× `1a40:0201` 7-port MTT + 5× `1a40:0101` leaf | **6** | **20** |
| "100-port" hub — all 5 cables | | 30 | 100 |
| EC20 modem | — | 1 | — |

**Capacity per bus** with N cables from a 100-port hub behind the small hub:
`1 (root) + 4 (small hub) + 6N + modems ≤ 127`, and `modems ≤ 20N`

| N cables | hub cost | max modems |
|---|---|---|
| 4 | 29 | 80 (socket-limited) |
| **5** | **35** | **92 ← peak** |
| 6 | 41 | 86 |
| 10 | 65 | **62** |

**Past 5 cables, adding cables REDUCES capacity.** Concretely: 77 modems fit on 4 cables (106/127) but do **not** fit on 10 cables (142 > 127). **Fill a cable's 20 sockets before connecting another** — a half-empty block burns 6 addresses for nothing. 95 modems cannot fit on one bus (peak 92); two buses are mandatory.

**Bus ↔ physical socket** (verified via device-tree PHY phandles — controllers sharing a phandle share one physical connector). Board: Orange Pi 5 Plus (RK3588).

| Physical socket | Buses | Type |
|---|---|---|
| **A** | `usb1` (EHCI 480M) + `usb2` (OHCI 12M) — PHY `0x29` | USB 2.0 |
| **B** | `usb3` (EHCI 480M) + `usb4` (OHCI 12M) — PHY `0x2b` | USB 2.0 |
| **C** | `usb5` + `usb6` — same controller `fc400000.usb` | USB 3.0 xHCI — **leave unused** |

Each bus has its own independent 127-address pool. Prefer EHCI: EC20 is USB 2.0 (480M cap) so xHCI's 5Gbps adds nothing, and xHCI's large per-device context ran out of resources with many devices (`error -12` ENOMEM, every modem failed to configure).

### USB failure modes — two distinct causes, do not conflate

**A. Signal integrity (verified).** `error -71` (EPROTO), `error -32` (EPIPE), `Cannot enable. Maybe the USB cable is bad?`. **Count the path segments to get the blast radius:**
- `1-1.4-port1` (2 segments) = a small-hub port → **an entire 20-socket block dies at once**, all its modems vanish together
- `1-1.3.3.4-port1` (4 segments) = a leaf-hub port → **a single modem**

Repeated retries on one port (39× observed) indicate an *intermittent* fault, not a hard break.

**B. Address exhaustion (verified).** When devnums 1–127 are all allocated, nothing new can enumerate. **It does NOT print "not accepting address"** — that message only appears *after* an address was allocated and `SET_ADDRESS` sent. Real exhaustion takes the `-ENOTCONN` path in `choose_devnum()`/`hub_port_init()`. Check with `lsusb | grep -c "Bus 001"`, not by reading error text.

### ⚠️ UNVERIFIED HYPOTHESIS — passive USB extension cables (raised 2026-08-05, NOT tested)

Passive extension cables are in use between 100-port hub sockets and EC20 modules to relieve physical crowding (hub sockets are too closely spaced).

- **Verified fact:** the USB spec prohibits A-plug-to-A-socket extension cables — they *"violate the cable length requirements of USB."*
- **Verified fact:** a passive cable adds **no** tier and consumes **no** address — it is invisible to `lsusb`. It does not affect the address budget.
- **GUESS, not confirmed:** that these cables are causing the per-modem enumeration failures. Suspected mechanism is voltage drop across thin conductors during LTE TX current bursts → module brownout → repeated re-enumeration, which would fit the observed "retry many times on one socket" pattern.

**Do not treat this as diagnosed.** To test it: pick a port that repeatedly logs `Cannot enable` (e.g. `1-1.3.3.4-port1`), remove its extension cable, plug the module straight into the hub, restart the daemon, and see whether that one socket stabilises. If it does, the hypothesis holds for that class of failure.

### USB diagnostics
```bash
lsusb | grep -c "Bus 001"                        # addresses used on bus1 (limit 127)
lsusb | grep "Bus 001" | grep -c 1a40            # how many of those are hub chips
lsusb | grep -c 2c7c                             # EC20 count
dmesg | grep -oE "usb [0-9.-]+-port[0-9]+: (Cannot enable|unable to enumerate)" | sort | uniq -c | sort -rn
```

Vendor IDs: `1a40:0101` = Terminus 4-port hub chip, `1a40:0201` = Terminus 7-port MTT hub chip, `2c7c` = Quectel EC20 (descriptors may misreport as `0125`), `05e3` = Genesys hub (wired to xHCI — leave unused).

Long-form analysis with topology diagrams: README → "Hardware / USB Topology".
