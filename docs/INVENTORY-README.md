# Modem Inventory Guide

> **Every claim below was re-verified against the daemon source, the CSV contents, and the live
> Orange Pi on 2026-08-06.** Corrections from the previous revision are marked ❗.

## Files

| File | Rows | Captured | Status |
|------|------|----------|--------|
| [modem-inventory-2026-03-09.csv](modem-inventory-2026-03-09.csv) | 70 modems | 2026-03-09 | ❗ **HISTORICAL** |
| [modem-inventory-with-hub-paths.csv](modem-inventory-with-hub-paths.csv) | 70 modems | 2026-03-09 | ❗ **HISTORICAL** |

❗ **Both CSVs are stale snapshots, not current state.** They describe 70 modems all on Bus 001 with
short hub chains. As of 2026-08-06 the fleet is **77 modems across two buses** (66 on Bus 001,
11 on Bus 003) and every path is 5 levels deep. The cabling itself was rearranged on 2026-08-06
(3 cables moved off Bus 001), so **the `hub_path` column in these files no longer locates anything.**

Live sources of truth instead:
- **Database** — `device_view.usb_path`, populated by the daemon (migration `034`)
- [`sim-ec20-usb-location.md`](../sim-ec20-usb-location.md) (repo root, 2026-06-15) — SIM ↔ IMEI ↔ USB path table
- **The hardware** — `lsusb -t`, or `readlink -f /sys/class/tty/ttyUSBn/device`

## Column Definitions

### modem_index
- ❗ **What**: Not a sequential index — it is **literally the ttyUSB number**. `port_to_modem_id()`
  (`at_modem.rs:1672`) just strips the prefix: `/dev/ttyUSB224` → `"224"`.
- **Source**: Daemon's `list_modems()` (`modem_manager.rs:99`), which enumerates AT ports
- ❗ **Range**: `0–73` in the March CSV, but **2–304 on the live system** — the number tracks USB
  enumeration order, so it grows with fleet size (306 `ttyUSB` nodes today, 4 per modem).
- ❗ **Stability**: ❌ **NOT FIXED — and it changes *within* a running session, not just across
  restarts.** 132 distinct modem IDs appeared in one 16-hour daemon session serving only 77 modems,
  because modems that drop and re-enumerate come back on new ttyUSB numbers.
- **Use**: Nothing durable. Valid only for the AT command you are about to send.

### usb_bus
- **What**: Linux USB bus number = one USB host controller + its root hub
- ❗ **Value**: `001` **or** `003` — as of 2026-08-06 modems live on both. The March CSV shows only `001`.
- **Source**: `lsusb` (first field)
- **Stability**: ✅ **FIXED** — bus numbers follow device-tree probe order, so `usb1`/`usb3` are the
  two EHCI USB 2.0 controllers on every boot
- **Use**: Identifies which **independent 127-address pool and bandwidth domain** the modem sits in.
  This is operationally critical: on 2026-08-06 Bus 001 was at 107/127 addresses while Bus 003 was
  at 18/127, and Bus 001 carried all 246 signal-error log lines while Bus 003 carried zero.
- ❗ The Orange Pi has **six** buses, not one: `usb1`/`usb3` EHCI (480M, use these), `usb2`/`usb4`
  OHCI companions (12M, unused), `usb5`/`usb6` xHCI (leave unused — ENOMEM at scale). A previous
  revision of this file stated "only one on Orange Pi"; that was wrong.
  See CLAUDE.md → "USB address budget".

### usb_device
- **What**: The device's **USB address** (devnum) — drawn from that bus's pool of 127
- **Source**: `lsusb` (second field)
- **Stability**: ❌ **NOT FIXED** — reassigned on reboot/replug
- **Use**: Temporary reference within one boot. Counting these per bus is how you measure address
  headroom: `lsusb | awk '{print $2}' | sort | uniq -c`

### hub_path
- ❗ **Status: OBSOLETE FORMAT — do not produce new data in it.**
- **What it was**: the hub chain rendered with volatile device numbers,
  e.g. `Dev001 → Dev057 → Dev060 → Dev062 → Dev066 → Port004`
- ❗ **Why it fails**: every `DevNNN` token is reassigned on reboot, so the string cannot be resolved
  later — and it isn't uniform. Row 1 of the CSV is only `Dev001 → Dev002 → Port003` (3 elements)
  while row 44 has 6, so you cannot even parse depth reliably.
- ❗ **Use this instead — `usb_path`**, the kernel devpath, e.g. `1-1.4.1.2.3`:
  ```
  1  -  1  .  4  .  1  .  2  .  3
  │     │     │     │     │     └── port on the leaf 4-port hub  → THE MODEM
  │     │     │     │     └──────── port on the MTT block (the cable)
  │     │     │     └────────────── port on the small hub's internal chip
  │     │     └──────────────────── port on the small hub's upstream chip
  │     └────────────────────────── root-hub port (always 1 — root hubs have 1 port)
  └──────────────────────────────── bus number (1 or 3)
  ```
  Every element is a **physical port number**, so the string survives reboot, replug and daemon
  restart. The daemon reports it (`worker_pool.rs:311`), it is stored in `modems.usb_path`
  (migration `034`), and exposed by `device_view`. `NULL` means the modem is not currently
  enumerated on a working socket.
  ```bash
  readlink -f /sys/class/tty/ttyUSB0/device   # → .../1-1.4.1.2.3/... (verified 2026-08-06)
  ```
- ❗ **Caveat on "topology is fixed"**: port numbers are stable only while the **cabling** is
  unchanged. Moving a cable to a different hub socket — as happened on 2026-08-06 — rewrites the
  path for every modem behind it. A `usb_path` is a location, not an identity; the IMEI is the identity.

### imei
- **What**: International Mobile Equipment Identity, **exactly 15 digits** (the parser rejects
  anything else — `at_modem.rs:563`)
- **Source**: `AT+CGSN` ✅ verified
- **Stability**: ✅ **FIXED** — never changes, unique per modem
- **Use**: **PRIMARY IDENTIFIER** for tracking modems across reboots. Also the join key:
  `device_view` matches `sims.imei = modems.equipment_id`.

### iccid
- **What**: Integrated Circuit Card Identifier
- ❗ **Source**: `AT+QCCID` **first** (Quectel-specific), falling back to `AT+CCID` then `AT+ICCID`
  (`at_modem.rs:523`). For the EC20 fleet here the effective command is `AT+QCCID`, not `AT+CCID`.
- ❗ **Length**: parser accepts ≥18 chars (18–22 for an unprefixed line) and validates them as **hex**
  digits, not strictly decimal. **Observed in this inventory: only 19 or 20 digits** (51 rows of 20,
  19 rows of 19) — 18 never occurs, so the old "18-20 digits" was a parser bound, not real data.
- ❗ **Normalisation**: trailing `F` padding is stripped (BCD filler per ITU-T E.118,
  `normalize_iccid`). A 20-char reading ending in `F` therefore becomes a 19-digit ICCID — that is
  the source of the two lengths above, not two different SIM formats.
- **Stability**: ✅ **FIXED** — never changes, unique per SIM card
- **Use**: Identify which SIM is in which modem. `sim_status = 'active'` requires
  `modems.detected_iccid = sims.iccid`; a mismatch is the usual cause of a SIM looking "offline".

### phone_number
- **What**: Phone number assigned to the SIM
- ❗ **Source**: the **`sims` inventory table only** (user-entered). `AT+CNUM` *is* wired up
  (`at_modem.rs:639`, called from `worker_pool.rs:291`) but **yielded zero numbers across the live
  fleet** — most carriers never program the MSISDN onto the SIM. Treat CNUM as always-empty.
- **Stability**: ✅ **FIXED** — tied to the SIM, and the daemon never writes the `sims` table
- **Use**: Human-readable identifier

### operator
- **What**: Mobile network operator name
- ❗ **Source**: `AT+COPS?` — the **query** form with `?` (`at_modem.rs:659`). Bare `AT+COPS` is the
  set command and will not return the operator.
- **Stability**: ⚠️ **CHANGES** — reflects current registration
- **Use**: Verify the SIM registered to the expected carrier

## Example Entry (historical — 2026-03-09 snapshot)

Verified to exist at line 44 of both CSVs:

```csv
43,001,084,Dev001 → Dev057 → Dev060 → Dev062 → Dev066 → Port004,869604084768463,89860117811049221139,+8617600419127,StarHub
```

| Column | Value | Meaning |
|--------|-------|---------|
| modem_index | 43 | ❗ `/dev/ttyUSB43` at capture time — not a stable index |
| usb_bus | 001 | Bus 001 (`usb1`, EHCI). ❗ Today this could also be `003` |
| usb_device | 084 | USB address 84 of that bus's 127 (temporary) |
| hub_path | `Dev001 → … → Port004` | ❗ Obsolete format; unresolvable today |
| imei | 869604084768463 | **Modem's permanent ID** ✅ (15 digits) |
| iccid | 89860117811049221139 | **SIM's permanent ID** ✅ (20 digits) |
| phone_number | +8617600419127 | From the `sims` table, not from the modem |
| operator | StarHub | Registered network at capture time |

### Reading the chain

```
Dev001  →  Dev057  →  Dev060  →  Dev062  →  Dev066  →  Port004
  ↓          ↓          ↓          ↓          ↓          ↓
root hub   small hub  small hub  MTT block  leaf hub   physical
           upstream   internal   (7-port,   (4-port)   port #4
           (4-port)   (4-port)   = 1 cable)
```

❗ Chain length varies by row — some March rows are only `Dev001 → Dev002 → Port003`. The modern
equivalent of the chain above is simply `1-1.X.Y.Z.4`.

## How to Use This Inventory

### Find a modem by IMEI (the only durable lookup)
```bash
grep "869604084768463" modem-inventory-with-hub-paths.csv
```

### ❗ Locate a modem physically — use usb_path, not the CSV
```bash
# On the Orange Pi: every modem's stable physical path
for t in /sys/class/tty/ttyUSB*; do
  echo "$(basename $t) -> $(readlink -f $t/device | grep -oE '[0-9]+-[0-9.]+' | tail -1)"
done
```
Then read the path right-to-left: last digit = port on the leaf hub, next = which cable, and the
leading `1-` or `3-` tells you **which physical Orange Pi socket** (A or B) to start from.

### Track a modem across reboots
1. Note the **IMEI** before
2. Search for that IMEI after
3. `modem_index` and `usb_device` will differ — expected
4. ❗ `usb_path` holds **only if nobody moved a cable**; it is a location, not an identity
5. IMEI, ICCID and phone number are unchanged

## Quick Reference

### ✅ FIXED (persistent across reboots)
- **imei** — primary identifier, and the `device_view` join key
- **iccid** — identifies the SIM card
- **phone_number** — tied to the SIM, held in the `sims` table
- **usb_path** — ❗ stable across reboot/replug/daemon-restart, but **not** across re-cabling

### ❌ TEMPORARY (changes on reboot — and mid-session)
- **modem_index** — ❗ the ttyUSB number; changes even while the daemon runs
- **usb_device** — the USB address, reassigned per boot
- ❗ **hub_path** `DevNNN` tokens — obsolete format, unresolvable after any reboot

### ⚠️ BEST PRACTICE
Identify modems by **IMEI**. Locate them by **usb_path**. Never rely on `modem_index` or `hub_path`.

## Updating the Inventory

```bash
# 1. Topology snapshot
ssh root@10.171.150.102 "lsusb -t" > docs/usb-topology-$(date +%Y-%m-%d).txt

# 2. IMEI ↔ ICCID pairs — logged once per modem at daemon startup and on each rediscovery.
#    ❗ These lines only appear near daemon start, so pick a window that CONTAINS the start,
#    then check the count is non-zero before trusting the output.
ssh root@10.171.150.102 'systemctl show sms-daemon -p ActiveEnterTimestamp --value'
ssh root@10.171.150.102 'journalctl -u sms-daemon --since "-24h" | grep -c "Cached modem"'   # must be > 0
ssh root@10.171.150.102 'journalctl -u sms-daemon --since "-24h" | grep "Cached modem"'
#    Format: "✅ Cached modem <ttyUSB#> with ICCID <iccid> (IMEI <imei>)"
#    A "⚠️ Cached modem N without ICCID" line means the SIM read failed on that port.

# 3. Physical location — read usb_path from sysfs (see the loop above), or query the DB:
bunx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT iccid, imei, usb_path, sim_status FROM device_view ORDER BY sim_index"
```

❗ Prefer step 3's `usb_path` over regenerating the `hub_path` column — the `Dev` numbers make the
old format worthless the moment the machine reboots.
