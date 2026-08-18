# SMS Dashboard — Project Context

## Compact Instructions

When compressing, preserve in priority order:

1. Architecture decisions (NEVER summarize)
2. Modified files and their key changes
3. Current verification status (pass/fail)
4. Open TODOs and rollback notes
5. Tool outputs (can delete, keep pass/fail only)

## Overview
Distributed SMS management system designed for **100+ USB modems** on Orange Pi hardware.
- **Production URL**: https://sexy.qzz.io
- **Daemon version**: v8.0.0 (Rust, direct AT commands, ~8800 LOC)
- **Orange Pi SSH**: `root@10.171.150.102` (internal LAN, NixOS aarch64)

## Architecture
```
Orange Pi (Rust Daemon) → Cloudflare Workers API → Svelte 5 Frontend
    ↓                         ↓                        ↓
USB Modems (AT/D-Bus)    D1 Database (SQLite)     Auth0 + RBAC
```

### Data Model (SIM-Centric) — schema verified against live D1, 2026-08-06
```
sims (user inventory)              ← Source of truth, daemon NEVER writes
  └─ device_view                   ← PRIMARY read view, all queries use this
       └─ LEFT JOIN modems  ON sims.imei = modems.equipment_id
                                   ← Daemon-detected hardware + signal data
```
**The join key is IMEI, not ICCID.** `modems.equipment_id` *holds the IMEI* — it is burned into the
hardware and does **not** change with USB position (`usb_port`, `modem_index` and `usb_path` are the
position-dependent fields). `sims.iccid` is the primary ID for a *SIM*; `equipment_id`/IMEI is the
primary ID for a *modem*, and the view is stitched together by the latter.

`device_view.sim_status` is a 6-state CASE (migration `033`/`034`), evaluated in this order:

| State | Condition |
|---|---|
| `unassigned` | `sims.imei IS NULL` — inventory row with no modem assigned |
| `no_modem` | no matching `modems` row for that IMEI |
| `offline` | `modems.status = 'disconnected'` |
| `sim_error` | `detected_iccid IS NULL` — modem present, SIM unreadable |
| `active` | `detected_iccid = sims.iccid` |
| `iccid_mismatch` | detected ICCID ≠ inventory ICCID |

Do not copy historical inventory or active-modem counts into new behavior. Query
`device_view` when a current count is required.

⚠️ **`modem_state` no longer exists** — dropped in `033_clean_schema_refactor.sql`; its
`signal_percent`/`rssi` were merged into `modems`. Absent from the live schema.

⚠️ **`modems.current_iccid` is a DEAD legacy column — never query it.** Migration `033` copied it
into `detected_iccid`, and the active v8 `/api/control/devices` sync writes only
`detected_iccid`. The incompatible pre-`033` `/api/control/phones` route has been
removed. **Use `detected_iccid`.**

## Key Directories
| Path | Purpose | Tech |
|------|---------|------|
| `orange-pi-daemon/` | Hardware daemon (~8800 LOC) | Rust + Tokio async |
| `sms-dashboard/client/` | Frontend SPA | Svelte 5 + TailwindCSS + Vite 7 |
| `sms-dashboard/server/` | Backend API (JS) | Cloudflare Workers |
| `sms-dashboard/migrations/` | Sequential DB migrations (currently through `057`) | SQL (D1) |
| `nixos-config/` | System config | NixOS flake + SOPS |
| `ansible/` | Deploy automation | Ansible |
| `sql/` | DB maintenance queries | SQL |
| `docs/` | Documentation | Markdown |

## Active Multi-Week Plans

- [SMS hardware storage safety](docs/sms-hardware-storage-safety-plan.md) — staged
  `ME`/`SM` capacity monitoring, delete-retry safety, multipart draining, rollout
  gates, and weekly status. Stability takes priority; no behavior-changing stage
  may be enabled without its recorded approval.
- [SIM balance queries](docs/sim-balance-query-plan.md) — carrier validation and
  controlled rollout. Automated balance queries depend on the hardware-storage
  safety gates above.
- [Balance Agent CLI](docs/balance-agent-cli.md) — one Auth0-authenticated terminal
  interface for company-AI menu work and visible China Unicom browser queries.
  Refresh and AI tokens stay in macOS Keychain; carrier cookies remain local.
- [Balance Agent productization plan](docs/balance-agent-product-plan.md) — turns
  the local AI and browser runners into one installable desktop product with device
  authentication, capability heartbeats, operator handoff, safe batch semantics,
  and an internal private-release process.

## Balance Runtime Skill

This is an application runtime skill, **not** a Codex `SKILL.md`:

| Component | Location / storage | Responsibility |
|---|---|---|
| Skill configuration | `sms-dashboard/migrations/042_add_balance_runtime_skills.sql` and production D1 `sim_balance_profiles.skill_config` | Objective, confidence threshold, maximum turns, currencies, and forbidden intents |
| Prompt and validation | `sms-dashboard/server/utils/balance-skill.js` | Menu extraction, prompt construction, and deterministic safety validation |
| Worker handler | `sms-dashboard/server/handlers/balance-skill-runner.js` | Job leases, server-side decision validation, SMS queuing, balance persistence, and audit writes |
| Unicom Worker handler | `sms-dashboard/server/handlers/unicom-web-balance.js` | Browser-job leases, strict OTP correlation, account validation, normalized result persistence, and audit events |
| Runner control plane | `sms-dashboard/server/handlers/balance-runners.js` and migration `055` | Installation identity, capability heartbeat, online expiry, and dashboard status |
| Shared runner core | `sms-dashboard/runner-core/` | Auth0 session, authenticated control client, 30-second presence heartbeat, serial cancellation, and capability lifecycle |
| Balance Agent interfaces | `sms-dashboard/balance-agent/` | Electron shell plus CLI, OS-encrypted credentials, separate AI/browser loops, notifications, and Playwright Chromium |
| Nix developer interface | `flake.nix` | `balance-agent` command and `nix run .#balance-agent-cli` app |
| Operations document | `docs/balance-agent-cli.md` | CLI setup, trust boundaries, commands, and rollback |

Production D1 runtime tables:

- `sim_balance_skill_jobs`: durable pending/leased/completed/stopped jobs.
- `sim_balance_skill_decisions`: model, confidence, evidence, selected option, and final action audit.
- `sim_balance_metrics`: validated balances such as `cash_balance` in `CNY`.

Balance Agent routing is account-scoped by migration `057`:
`sim_balance_checks.requested_by_subject` stores the Dashboard user's Auth0 `sub`.
Auth0 device runners may claim and mutate only checks with the same `sub`; runner
status/preflight are filtered to that user. `NULL` is reserved for legacy API-key
control jobs, which only legacy API-key runners may claim.

Balance Agent is distributed only as an internal team utility. Its release pipeline
must be owned by `flake.nix`, produce ad-hoc-signed macOS `.dmg`/`.zip` artifacts
and SHA-256 checksums, and publish them to private GitHub Releases. Developer ID
signing and notarization are deferred while the audience remains the trusted team.
Do not add silent automatic updates to an ad-hoc-signed build; update discovery may
open the authenticated private Release page for an explicit manual install.

`nix run .#release-balance-agent -- <version>` is the implemented release driver.
It builds the `.app` with `electron-builder --mac dir --arm64`, zips it, and writes
a SHA-256 checksum into `sms-dashboard/balance-agent/release/<version>/`. It is a
`writeShellApplication` wrapper, so it runs the repo's own `bun`/`electron-builder`
and needs network access for Playwright Chromium — it is not a hermetic derivation.
Uploading the artifacts to the private GitHub Release remains a manual step.
`nix build .#balance-agent` (a hermetic, offline-dependency derivation) is still
unimplemented and must not be documented as an available command.

## Commands

> **Secret boundary:** Agents may inspect only encrypted key names in
> `secrets/dev-vars.yaml`. They must never decrypt, print, infer, validate, or edit
> its values, and must not invoke `sops exec-env` or Balance Agent commands that
> access Keychain or live services (`credentials`, `login`, `logout`, `status`,
> `doctor`, or `run`) by default. A user may explicitly authorise one exact
> secret-consuming command in the current task; that does not permit reading,
> printing, or editing secret values, and does not grant standing permission.

```bash
# Local dashboard (run from the repo root; direnv loads the flake dev shell)
dev-server restart                                    # Supervise the unique frontend :8080 + API :8787 pair
dev-server status                                     # Show listener ports and PIDs
dev-server logs                                       # Show frontend/API log paths under /tmp
dev-server stop                                       # Stop both managed processes

# Single-service debugging only; normal development uses dev-server
dev-frontend                                          # Strict Vite server on 127.0.0.1:8080
dev-api                                               # Strict Wrangler API on :8787, secrets via SOPS

# Balance Agent CLI (configuration/status are local; run claims live work)
balance-agent --help
balance-agent configure --dashboard-url URL --auth0-issuer URL --auth0-client-id ID --auth0-audience AUDIENCE
balance-agent credentials set-ai-token               # Secure macOS Keychain prompt
balance-agent login                                  # Auth0 Device Authorization Flow
balance-agent doctor
balance-agent run                                    # Independent SMS AI + browser loops
balance-agent run --capability sms-ai --once
balance-agent run --capability unicom-browser --once
balance-agent status
balance-agent logout

# Balance Agent desktop development (does not read dev-vars.yaml)
cd sms-dashboard/balance-agent && bun install
bun run test                                         # Device auth and secure-store tests
bun run start                                        # Build and launch the local Electron application
bun run cli -- --help                                # Run the source CLI directly
bun run pack:mac                                     # Current unsigned local .app packaging check

# Balance Agent release (from repo root; needs network for Playwright Chromium)
nix run .#release-balance-agent -- 0.1.0             # .app + .zip + .sha256 under balance-agent/release/<version>/

# Dashboard build/deploy
cd sms-dashboard && bun install
bun run build                                         # Production build
bun run deploy                                        # Build + deploy to CF

# Database
bunx wrangler d1 execute sms-dashboard --local --file=migrations/schema.sql
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"
bunx wrangler tail sms-dashboard --format pretty       # Live API logs

# Rust daemon
cd orange-pi-daemon && cargo build --release
check-daemon                                          # Required rustfmt check + all Rust tests
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
`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_M2M_CLIENT_ID`,
`AUTH0_M2M_CLIENT_SECRET`, `AUTH0_AUDIENCE`, `API_KEY`. `AUTH0_AUDIENCE` is required
for the Dashboard and Balance Agent to receive API access tokens. The M2M application
is used for Auth0 Management API operations on the user-management page; it is
separate from the interactive login client.

## Database Schema (Cloudflare D1)
- **`sims`** — user SIM inventory (PK: iccid). Source of truth for phone_number,
  carrier, sim_index, and manually verified `service_type`
  (`unknown`/`prepaid`/`postpaid`). The daemon and balance parsers NEVER write or
  infer the service type.
- `modems` — daemon-detected hardware (PK: equipment_id = IMEI). Stale rows can persist for hardware no longer plugged in. **`detected_iccid`** says which SIM is inserted; it also carries `signal_percent`/`rssi` and `usb_path`.
  - ⚠️ `current_iccid` is a dead legacy column, frozen since migration `033` — **never query it**, use `detected_iccid`.
- `messages` — SMS content, FK to sims
- `daemon_health` — heartbeat monitoring
- **`device_view`** — SIM-centric read view: `sims LEFT JOIN modems ON sims.imei = modems.equipment_id`. Use for ALL reads.
- ⚠️ `modem_state` was **dropped** in migration `033` — its signal data now lives on `modems`.

## Gotchas and Patterns

### Must-know
- **Always use `device_view`** for reading device data — never query raw tables directly
- **Package manager is `bun`**, not npm — all scripts use `bunx`
- **Local dashboard lifecycle is owned by `dev-server` from `flake.nix`** — after dashboard edits, run `dev-server restart` and leave its foreground supervisor running. Do not launch `bun run dev` or `bun run dev:api` directly: the managed command clears prior listeners, fixes the ports at frontend `8080` and API `8787`, checks both health endpoints, and enforces one listener PID per port.
- **Local Auth0/API credentials come only from `secrets/dev-vars.yaml`** — `dev-api` uses `sops exec-env` and `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` to pass decrypted values into Bun/Wrangler without plaintext files or command-line secret arguments.
- **Cloudflare access for message-dashboard uses Google login with a `bitgc.io` account** — before running Wrangler deployment or production D1 commands, use `bunx wrangler whoami` and confirm the authenticated email ends in `@bitgc.io` and the intended Cloudflare account is selected.
- **No repository-wide JavaScript lint command is configured** — follow the existing
  style; Rust changes must pass the `check-daemon` rustfmt gate.
- **No WebSocket/SSE in production** — manual refresh only (cost optimization). All WS/SSE code has been removed.
- **Router is custom** — `SimpleRouter` class in `server/index.js`, not itty-router

### Daemon gotchas
- AT commands are primary interface (1-5ms). D-Bus/ModemManager is fallback only (50ms)
- The primary direct-AT receive path persists a message before attempting an exact
  physical-store/index delete. Five-minute local queue/segment cleanup is legacy
  housekeeping, not a safe physical-delete retry; follow the storage safety plan.
- Local SQLite queue (`message_store.rs`) buffers messages when network is down, uploads in batches of 10-100
- Worker pool defaults to 16 concurrent modem readers in batches of 24 with a
  12-second per-modem timeout; Tokio runtime uses 4 threads.
- Signal cache: 30s TTL, 256-entry hash — avoid redundant modem queries
- **Daemon health schema v1** — the Rust daemon posts an independent health snapshot
  to `/api/control/heartbeat` every 30s. `daemon_health.metadata` stores per-task
  success ages/failures, queue depth, modem counts, session ID, and the real build
  version. Worker receipt time is the liveness clock; never use the Orange Pi wall
  clock for freshness.
- **Health states are separate from SIM states** — `healthy`, `degraded`, `offline`,
  and `unknown` describe the collection service. `device_view.sim_status` and the
  `93 / 95` count describe individual inventory rows. Do not infer one from the other.
- **Legacy heartbeat compatibility** — pending-SMS and device-sync routes only refresh
  liveness until a schema-v1 snapshot exists. After that, they may update their own
  data but must not make the whole daemon healthy.

### Server gotchas
- Middleware chain order: CORS → Auth0 JWT → RBAC (order matters)
- Daemon authenticates with API key header, users with Auth0 JWT
- Handler modules live in `server/handlers/`; new endpoints belong there and must
  include focused handler tests.
- `/api/control/phones` was removed because it depended on the pre-`033` schema.
  The v8 daemon uses `/api/control/devices`; do not reintroduce the legacy route.

### Network
- The verified NixOS SSH/deploy target is `root@10.171.150.102` on the internal
  network. Do not substitute the historical public address: it is not a verified
  authenticated deployment endpoint.
- **SSH over FortiClient VPN**: the tunnel's broad `10.171/16` route via `ppp0` is wrong for the Orange Pi. Before `ssh root@10.171.150.102`, add a host route through the correct gateway:
  ```sh
  sudo route add -host 10.171.150.102 10.171.121.1
  ```
  Symptom when missing: ping = 100% loss, SSH exits 255. The route persists until the VPN reconnects, so re-run it after each FortiClient reconnect.
  **Only needed when on the VPN.** From the office LAN, `ssh root@10.171.150.102` works with no route hack (verified 2026-08-06, ~5.7ms RTT). Test with `ping -c2` first and skip the `sudo route` step if it already replies.
- Sync intervals: device status every 30s, full sync every 5min (keeps under CF rate limits)

### SIM detection gotchas
- **Modem ID = USB port position**, not physical modem. `modem 14` means ttyUSB58, not a specific device.
- **`AT+CNUM` usually returns empty** — most carriers don't program MSISDN. Phone numbers come from `sims` table inventory.
- **Modem discovery is dynamic** — the initial cache is built at startup and the
  daemon scans every 60 seconds for newly enumerated or recoverable AT modems.
  Devices that never enumerate a ttyUSB path still require a hardware fix; restart
  only when re-discovery cannot recover the expected device state.
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

**Every root hub has exactly 1 port** (`maxchild=1`, verified 2026-08-06). So one physical socket accepts exactly **one** upstream cable. A single 100-port-hub cable can be plugged in directly (cost 6 addresses, 20 sockets); attaching a **second** cable to the same socket requires inserting the small hub first, which costs 4 more addresses.

**Capacity per bus** with N cables from a 100-port hub behind the small hub:
`1 (root) + 4 (small hub) + 6N + modems ≤ 127`, and `modems ≤ 20N`
(Direct-connect, no small hub, only possible for N=1: `1 + 6 + modems ≤ 127`, `modems ≤ 20`.)

| N cables | hub cost | max modems |
|---|---|---|
| 4 | 29 | 80 (socket-limited) |
| **5** | **35** | **92 ← peak** |
| 6 | 41 | 86 |
| 10 | 65 | **62** |

**Past 5 cables, adding cables REDUCES capacity.** Concretely: 77 modems fit on 4 cables (106/127) but do **not** fit on 10 cables (142 > 127). **Fill a cable's 20 sockets before connecting another** — a half-empty block burns 6 addresses for nothing. 95 modems cannot fit on one bus (peak 92); two buses are mandatory.

**Bus ↔ physical socket** (verified via device-tree PHY phandles — controllers sharing a phandle share one physical connector). Board: Orange Pi 5 Plus (RK3588).

| Physical socket | Buses | Controller (as probed) | Type |
|---|---|---|---|
| **A** | `usb1` (EHCI 480M) + `usb2` (OHCI 12M) — PHY `0x29` | `fc800000.usb` / `fc840000.usb` | USB 2.0 |
| **B** | `usb3` (EHCI 480M) + `usb4` (OHCI 12M) — PHY `0x2b` | `fc880000.usb` / `fc8c0000.usb` | USB 2.0 |
| **C** | `usb5` (480M) + `usb6` (5000M) | both `xhci-hcd.5.auto` — **one** controller instance | USB 3.0 xHCI — **leave unused** |

Each bus has its own independent 127-address pool. Prefer EHCI: EC20 is USB 2.0 (480M cap) so xHCI's 5Gbps adds nothing, and xHCI's large per-device context ran out of resources with many devices (`error -12` ENOMEM, every modem failed to configure).

**Why EHCI needs two buses per socket but xHCI also shows two.** Different reasons — don't conflate. EHCI only speaks High-Speed, so Full/Low-Speed devices on the same pins must be handled by a separate *companion* OHCI controller → two controllers, two buses. xHCI speaks all speeds from one controller, but registers **two buses anyway** (one for the USB-2 pairs, one for the SuperSpeed pairs) because those are physically separate wire pairs. So `usb5`/`usb6` sharing `xhci-hcd.5.auto` is one chip, two buses; `usb1`/`usb2` are genuinely two chips.

### Historical hardware snapshot (measured 2026-08-06)

The figures below are diagnostic history, not current fleet state. Query the live
daemon and D1 before making an operational decision.

**77 modems live** (66 on bus1 + 11 on bus3) against a 95-SIM inventory → **18 short**. Both EHCI sockets are now in use; bus3 is no longer a plan.

| bus | addresses used /127 | hub chips | EC20 | cables | signal-error lines this boot |
|---|---|---|---|---|---|
| **001** | **107** | 40 (= 4 small hub + 6 cables × 6) | **66** | 6, behind small hub | **246** |
| **003** | **18** | 6 (one cable, direct — no small hub) | **11** | 1 | **0** |
| 005 / 006 | 2 / 2 | 1× Genesys `05e3` | 0 | — | — |

Over-current events: **0** (again — never the power supply).

- **bus1 is address-bound, not socket-bound.** 6 cables = 120 sockets, only 66 filled → **54 sockets are permanently unusable** because just 20 addresses remain. Ceiling is 86 (matches the N=6 row above). This is the "past 5 cables it gets worse" rule already realised in hardware — the 6th cable bought 20 sockets that cannot be populated.
- **Put the remaining 18 modems on bus3, none on bus1.** bus3 has 109 free addresses and zero errors; its single cable has only 9 free sockets, so a 2nd cable is needed → insert the small hub (`1 + 4 + 12 = 17` addresses, 40 sockets). Re-seating the existing cable under the small hub re-enumerates everything on bus3 — restart the daemon afterwards.
- **`device not accepting address` was observed on bus1 with 20 addresses still free** — direct confirmation of the failure-mode rule below: that string never means exhaustion.
- **Unexplained (2026-08-06):** 306 `ttyUSB` nodes vs 308 expected (77 × 4). Two interfaces missing somewhere; not chased down.

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

**Natural A/B pair now available (2026-08-06).** bus1 logs **246** signal-error lines, bus3 logs **0** — same filter, and it demonstrably matches on bus1, so bus3's zero is real absence, not a broken filter. If bus3's 11 modules are plugged **straight into** their hub while bus1's use extension cables, that is strong evidence for the hypothesis and nearly free to check. **The cabling of bus3 has not been confirmed** — establish that before drawing any conclusion.

### USB diagnostics

Both EHCI buses carry modems now — **never report a number without saying which bus it came from.**

```bash
lsusb | awk '{print $2}' | sort | uniq -c        # addresses used PER BUS (limit 127 each)
lsusb | grep "Bus 003" | grep -c 1a40            # hub chips on a given bus
lsusb | grep -c 2c7c                             # EC20 count (all buses)
lsusb -t                                         # tier structure; confirms cable/leaf-hub layout

# per-bus signal errors — run on a known-bad bus first to prove the filter matches
dmesg | grep -cE "usb 3-[0-9.]+.*(Cannot enable|not accepting address|unable to enumerate|error -(71|32|12))"

# controllers and their root-hub port counts
for d in /sys/bus/usb/devices/usb*; do
  echo "$(basename $d) bus=$(cat $d/busnum) speed=$(cat $d/speed) ports=$(cat $d/maxchild) $(basename $(readlink -f $d/../driver))"
done
```

**Shell gotcha when counting per-cable occupancy:** a glob `*` matches dots, so `/sys/bus/usb/devices/3-1.*` matches `3-1.2` **and** `3-1.2.3`. Naively summing "direct children" plus "grandchildren" double-counts every modem (produced a bogus `free = -2` on 2026-08-06). Match depth explicitly, e.g. `3-1.[0-9]` vs `3-1.[0-9].[0-9]`, or derive counts from `lsusb -t`.

Vendor IDs: `1a40:0101` = Terminus 4-port hub chip, `1a40:0201` = Terminus 7-port MTT hub chip, `2c7c` = Quectel EC20 (descriptors may misreport as `0125`), `05e3` = Genesys hub (wired to xHCI — leave unused).

Long-form analysis with topology diagrams: README → "Hardware / USB Topology".
