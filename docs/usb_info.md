# USB Modem Topology

Hardware configuration for 100+ USB modems on Orange Pi.

## Current Configuration (2026-03-09 15:59)

| Metric | Count |
|--------|-------|
| Physical modems detected by USB | **73** |
| Modems initialized by daemon | 72 |
| Modems with SIM cards (active) | **70** |
| Modems without SIM cards | 2 (modem 7, 67) |
| ttyUSB ports created | 292 (73 × 4) |
| Missing modems (expected 78) | **5** |

**Complete Inventory**: See [modem-inventory-2026-03-09.csv](modem-inventory-2026-03-09.csv) for full mapping of:
- Modem Index → USB Bus.Device
- IMEI (equipment_id)
- ICCID (SIM card ID)
- Phone Number
- Operator Name

## Hardware Architecture

### Cascaded USB Hub Topology

```
Orange Pi EHCI Root Hub (Bus 001, 480Mbps)
  └─ Level 1: 4-port hub (Dev 057)
       ├─ Level 2: 4-port hub (Dev 058)
       ├─ Level 2: 4-port hub (Dev 059)
       │    ├─ Level 3: 7-port hub (Dev 061)
       │    │    ├─ Level 4: 4-port hubs (Dev 064, 068, 074, 085, 100)
       │    │    │    └─ Modems (3-4 per hub)
       │    ├─ Level 3: 7-port hub (Dev 063)
       │    │    ├─ Level 4: 4-port hubs (Dev 069, 076, 088, 104, 122)
       │    │    │    └─ Modems (3-4 per hub)
       │    └─ Level 3: 7-port hub (Dev 067)
       │         ├─ Level 4: 4-port hubs (Dev 075, 086, 101, 117, 009)
       │         │    └─ Modems (3-4 per hub)
       └─ Level 2: 4-port hub (Dev 060)
            ├─ Level 3: 7-port hub (Dev 062)
            │    ├─ Level 4: 4-port hubs (Dev 066, 071, 080, 094, 109)
            │    │    └─ Modems (3-4 per hub)
            └─ Level 3: 7-port hub (Dev 065)
                 ├─ Level 4: 4-port hubs (Dev 072, 081, 095, 110, 002)
                 │    └─ Modems (3-4 per hub)
```

**Design**: 4-tier cascaded topology optimized for 100+ modems
- Tier 1: Root hub (1 port used)
- Tier 2: 4-port distribution hubs (4 hubs)
- Tier 3: 7-port aggregation hubs (6 hubs = 42 ports potential)
- Tier 4: 4-port modem hubs (20+ hubs)

**Bandwidth**: All hubs operate at USB 2.0 High Speed (480Mbps). Per-modem bandwidth ~6.5Mbps theoretical.

## Quectel EC25 Modem USB Interfaces

Each modem exposes **5 USB interfaces**:

| Interface | Class | Driver | Device | Purpose | Daemon Uses |
|-----------|-------|--------|--------|---------|-------------|
| If 0 | Vendor Specific | `option` | ttyUSB*0 | DM/Diagnostic | No |
| If 1 | Vendor Specific | `option` | ttyUSB*1 | GPS/NMEA | No |
| If 2 | Vendor Specific | `option` | ttyUSB*2 | **AT Commands** | **Yes** |
| If 3 | Vendor Specific | `option` | ttyUSB*3 | PPP data | No |
| If 4 | Vendor Specific | `qmi_wwan` | wwan* | QMI network | No |

**Daemon configuration**: Uses direct serial AT commands on ttyUSB*2 (bypasses ModemManager for better performance).

### Port Numbering Pattern

For a modem enumerated as device N on port P:
- `ttyUSB(N*4 + 0)` — DM/diagnostic
- `ttyUSB(N*4 + 1)` — GPS
- `ttyUSB(N*4 + 2)` — **AT commands** ← daemon uses this
- `ttyUSB(N*4 + 3)` — PPP

Example: Modem 15 → ttyUSB60, ttyUSB61, ttyUSB62 (AT), ttyUSB63

## Known Issues and Limitations

### 1. Missing 5 Modems (78 expected, 73 detected)

**Status**: 5 modems physically present but not enumerated by USB

**Possible causes**:
- USB hub bandwidth saturation (73 × 5 interfaces = 365 endpoints)
- Power delivery limits on hub cascade
- Loose USB connections or damaged ports
- ModemManager initialization failures during boot
- Hub port exhaustion (cascaded hub ports may be at capacity)

**Diagnostics**:
```bash
# Check USB errors
dmesg | grep -i 'usb\|hub' | grep -E 'error|reset|cannot'

# Verify hub power
lsusb -t | grep -i hub

# Check modem LED indicators (should see 78 power LEDs)
# Physical inspection required
```

**Workaround**: Reboot Orange Pi to force full USB re-enumeration:
```bash
systemctl reboot
```

### 2. Modems Without SIM Cards (2 inactive)

**Status**: 2 modems detected but excluded from daemon processing

**Modems**:
- Modem 67 (IMEI 865827078379005)
- Modem 7 (IMEI 865827078377009)

**Behavior**: Daemon filters these out during startup (main.rs:156-224). They appear in `mmcli -L` but not in active modem list.

**Fix**: Install SIM cards in these slots to bring total from 70 → 72 active.

### 3. Daemon Modem Cache is Static

**Status**: Daemon builds modem list once at startup and never refreshes

**Impact**: Hot-plugged modems after daemon start won't be detected

**Location**: [orange-pi-daemon/src/main.rs:156-232](../orange-pi-daemon/src/main.rs)

**Workaround**: Restart daemon after plugging in new modems:
```bash
systemctl restart sms-daemon
```

**Future improvement**: Add periodic modem re-scan (e.g., every 5 minutes) or UDEV hotplug hooks.

## Verification Commands

### Check physical USB detection
```bash
# Count Quectel modems
lsusb | grep -i quectel | wc -l

# Show USB tree
lsusb --tree | less

# Count ttyUSB ports (should be modem_count × 4)
ls /dev/ttyUSB* | wc -l
```

### Check daemon state
```bash
# View daemon startup logs
journalctl -u sms-daemon -n 200 | grep 'Found.*modems' -A 50

# Current processing count
journalctl -u sms-daemon -n 50 | grep 'Processing.*modems'

# Check for SIM-less modems
journalctl -u sms-daemon | grep 'no SIM card'
```

### Check ModemManager state (if USE_DBUS=1)
```bash
# List all modems (requires mmcli)
mmcli -L

# Check specific modem
mmcli -m 0

# Check SIM card
mmcli -i 0
```

## Power Considerations

**Estimated power draw**:
- Quectel EC25 peak: 2W per modem (USB max 2.5W @ 5V/500mA per port)
- 73 modems peak: ~146W (requires multiple powered hubs)
- Orange Pi base: ~10W

**Powered hub requirements**:
- Use externally powered USB hubs (not bus-powered)
- Each 7-port hub should have dedicated 12V/5A power supply (60W)
- Avoid chaining more than 4 tiers (USB spec limit)

**Symptoms of insufficient power**:
- Random modem dropouts
- USB device reset errors in dmesg
- Modems enumerate but fail AT command initialization
- Brown-out crashes

## Future Capacity Planning

**Current limits**:
- USB bandwidth: 480Mbps shared across 73 modems = 6.5Mbps/modem (adequate for SMS, marginal for LTE data)
- USB endpoints: 365 endpoints (73 × 5) nearing USB controller limits (~400-500)
- Hub cascade: 4 tiers (at USB spec maximum)

**To scale beyond 80 modems**:
1. **Add second Orange Pi** with separate USB controller
2. **Use PCIe USB cards** (higher endpoint count, better bandwidth)
3. **Upgrade to USB 3.0 hubs** (10× bandwidth, more endpoints per controller)
4. **Optimize modem firmware** to disable unused interfaces (DM, GPS) reducing endpoints

## Debugging Checklist

When modem count drops or modems go missing:

- [ ] Run `lsusb | grep -i quectel | wc -l` → expect 73+
- [ ] Run `ls /dev/ttyUSB* | wc -l` → expect count × 4
- [ ] Check `dmesg | tail -100` for USB errors
- [ ] Verify daemon logs: `journalctl -u sms-daemon -n 100`
- [ ] Check power supplies on all USB hubs (LEDs lit, voltage stable)
- [ ] Physical inspection: count modem LEDs, check for loose cables
- [ ] Restart daemon: `systemctl restart sms-daemon`
- [ ] If persistent, reboot Orange Pi: `systemctl reboot`

## Complete Hardware Inventory

**Snapshot Date**: 2026-03-09 15:59 (daemon restart)
**Data Source**: Daemon startup logs + production D1 database

See [modem-inventory-2026-03-09.csv](modem-inventory-2026-03-09.csv) for the complete CSV.

### Summary Statistics

| Operator | Count | Countries |
|----------|-------|-----------|
| Singtel | 40 | SG, CN |
| Singtel CMCC | 16 | CN |
| StarHub | 6 | CN, HK |
| SGP-M1 | 3 | SG |
| Singtel Singtel | 17 | SG |
| **Total** | **70** | |

### Modem Distribution by ICCID Prefix

| Prefix | Country | Operator | Count |
|--------|---------|----------|-------|
| `8965012...` | Singapore (65) | M1/Singtel | 31 |
| `89860...` | China (86) | CMCC/China Mobile | 39 |
| `89852...` | Hong Kong (852) | CMHK | 1 |

### Sample Entries

| Modem | USB | IMEI | ICCID | Phone | Operator |
|-------|-----|------|-------|-------|----------|
| 0 | 001.003 | 865827078941325 | 8965012306052989699 | +6580291718 | Singtel Singtel |
| 1 | 001.004 | 865827078383361 | 89860040191833946279 | +8615089255778 | Singtel CMCC |
| 24 | 001.030 | 865827078973468 | 89852122111066626330 | +85246708256 | StarHub CMHK |
| 67 | — | 865827078379005 | — | — | NO_SIM |
| 7 | — | 865827078377009 | — | — | NO_SIM |

**Note**: Modems 67 and 7 have no SIM cards installed (excluded from active pool).

## References

- Complete inventory: [modem-inventory-2026-03-09.csv](modem-inventory-2026-03-09.csv)
- USB topology explanation: [usb-topology-explained.md](usb-topology-explained.md) ← **Read this for deep dive**
- Raw USB tree output: [usb-topology-2026-03-09.txt](usb-topology-2026-03-09.txt)
- Orange Pi documentation: [docs/deployment/orange-pi-setup.md](deployment/orange-pi-setup.md)
- Daemon architecture: [orange-pi-daemon/README.md](../orange-pi-daemon/README.md)
- Quectel EC25 datasheet: Quectel_EC2x_Series_Hardware_Design_V1.3.pdf
- USB 2.0 specification: USB_2.0_specification.pdf
