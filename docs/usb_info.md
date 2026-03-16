# USB Modem Topology

Hardware configuration for 100+ USB modems on Orange Pi.

## Current Configuration (2026-03-13 14:56 +08)

| Metric | Count | Notes |
|--------|-------|-------|
| **SIM inventory** (expected) | **95** | Total SIMs in `sims` table |
| **Physical modems detected by USB** | **71** | From `lsusb \| grep quectel` |
| **Modems initialized by daemon** | **70** | From daemon startup logs |
| **Modems with SIM cards (active)** | **68** | Currently being processed |
| **Active modems in DB** | **66** | Modems with `current_iccid` set |
| **Modems without SIM cards** | **2** | Modem 7, 67 (no ICCID detected) |
| **ttyUSB ports created** | **284** | 71 modems × 4 ports each |
| **Missing modems** | **24** | 95 expected - 71 detected = 24 missing |

### Status Summary
- ✅ **71 modems** physically connected and enumerated by USB
- ✅ **70 modems** detected by daemon (1 modem failed AT probe)
- ✅ **68 modems** actively processing messages (2 have no SIM)
- ⚠️ **24 modems** not detected at all (95 - 71 = 24)
- ⚠️ **2 modems** online but no SIM installed (slots 7, 67)

**Daemon uptime**: Since 2026-03-11 20:25:22 +08 (1 day 18 hours)

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

**Design**: 5-tier cascaded topology (at USB 2.0 maximum limit)
- Tier 1: Root hub (1 port used)
- Tier 2: 4-port distribution hubs (3 hubs)
- Tier 3: 7-port aggregation hubs (5 hubs)
- Tier 4: 4-port modem hubs (20+ hubs)
- Tier 5: Quectel EC25 modems (71 detected)

**Bandwidth**: All hubs operate at USB 2.0 High Speed (480Mbps). Theoretical per-modem bandwidth ~6.7Mbps.

## Quectel EC25 Modem USB Interfaces

Each modem exposes **4 USB serial interfaces** via the `option` driver:

| Interface | Class | Driver | Device | Purpose | Daemon Uses |
|-----------|-------|--------|--------|---------|-------------|
| If 0 | Vendor Specific | `option` | ttyUSB*0 | DM/Diagnostic | No |
| If 1 | Vendor Specific | `option` | ttyUSB*1 | GPS/NMEA | No |
| If 2 | Vendor Specific | `option` | ttyUSB*2 | **AT Commands** | **Yes** |
| If 3 | Vendor Specific | `option` | ttyUSB*3 | PPP data | No |

**Note**: The EC25 also has a 5th interface (If 4) for QMI network (`qmi_wwan` driver, creates `wwan*` device), but the daemon does not use it.

**Daemon configuration**: Uses direct serial AT commands on ttyUSB*2 (bypasses ModemManager for 1-5ms response time vs 50ms).

### Port Numbering Pattern

For modems enumerated sequentially, the daemon searches for AT command ports:
- Pattern: `ttyUSB2, ttyUSB6, ttyUSB10, ttyUSB14, ...` (every 4th port, offset 2)
- Logic: `if (port_number >= 2 && port_number % 4 == 2) → AT command port`

Example:
- Modem 0 → `/dev/ttyUSB0` (DM), `/dev/ttyUSB1` (GPS), `/dev/ttyUSB2` (AT), `/dev/ttyUSB3` (PPP)
- Modem 1 → `/dev/ttyUSB4` (DM), `/dev/ttyUSB5` (GPS), `/dev/ttyUSB6` (AT), `/dev/ttyUSB7` (PPP)

## Known Issues and Limitations

### 1. 24 Modems Missing (Critical Issue)

**Status**: 24 out of 95 expected modems not enumerated by USB subsystem

**Current state**:
- Expected: 95 modems (based on SIM inventory)
- USB detected: 71 modems
- Missing: **24 modems (25% failure rate)**

**Evidence from `dmesg`**:
```
USB device descriptor read/64, error -32
USB device descriptor read/64, error -71
device not accepting address, error -71
```

**Root causes (in order of likelihood)**:

#### A. USB System Capacity Exceeded (Most Likely)
- **Tier limit**: Using all 5 tiers (USB 2.0 maximum)
- **Endpoint pressure**: 71 modems × 5 interfaces = 355 endpoints (nearing ~400-500 controller limit)
- **Hub cascade complexity**: Some modems on deep hub branches fail enumeration
- **Symptom**: Error -32 (pipe error) indicates communication failure in deep topology

**Solution options**:
1. **Add second Orange Pi** - Split 95 modems across 2 systems (47-48 each)
2. **PCIe USB 3.0 card** - More endpoints, better bandwidth, separate controller
3. **Reduce modem interfaces** - Disable DM/GPS in firmware to free endpoints
4. **Simplify hub topology** - Reduce from 5 tiers to 4 tiers

#### B. Power Delivery Insufficient
- **Quectel EC25 draw**: 2A @ 5V = 10W peak (4× USB spec of 2.5W)
- **95 modems peak**: 950W theoretical
- **Symptom**: Error -71 (protocol error) suggests power-related enumeration failure

**Diagnostics**:
```bash
# Check for over-current conditions
dmesg | grep -i "over-current\|power"

# Physically verify hub power supplies (12V/5A for 7-port hubs, 5V/5A for 4-port)
```

#### C. USB Hub Firmware/Hardware Limits
- Some cheap hub controllers fail with many devices
- Terminus hubs (ID 1a40:0101, 1a40:0201) have known limits at scale

### 2. Modems Without SIM Cards (2 inactive)

**Status**: 2 modems detected but excluded from processing

**Modems**:
- Modem 7 (IMEI 865827078377009) - no SIM
- Modem 67 (IMEI 865827078379005) - no SIM

**Behavior**: Daemon filters these out during startup (main.rs:168-223). They appear in USB but not in active modem list.

**Fix**: Install SIM cards in these slots to increase active count from 68 → 70.

### 3. Daemon Modem Cache is Static

**Status**: Daemon builds modem list once at startup and never refreshes

**Impact**: Hot-plugged modems after daemon start won't be detected

**Location**: [orange-pi-daemon/src/main.rs:159-232](../orange-pi-daemon/src/main.rs)

**Workaround**: Restart daemon after plugging in new modems:
```bash
systemctl restart sms-daemon
```

**Future improvement**: Add periodic modem re-scan every 5 minutes or UDEV hotplug hooks.

### 4. 2 Modems Detected by USB but Not Daemon

**Status**: 71 USB modems → 70 daemon modems (1 modem lost)

**Possible causes**:
- AT command probe timeout (modem unresponsive)
- Serial port permission issue
- Modem firmware hung

**Diagnostic needed**: Check daemon logs for probe failures.

## Verification Commands

### Check physical USB detection
```bash
# Count Quectel modems detected by USB
lsusb | grep -i quectel | wc -l
# Expected: 71 (current)

# Count modem interfaces in USB tree
lsusb -t | grep "2c7c:" | wc -l
# Expected: 71 × 5 interfaces = 355 (if qmi_wwan counted)

# Show USB tree structure
lsusb -t | less

# Count ttyUSB ports (should be modem_count × 4)
ls /dev/ttyUSB* | wc -l
# Expected: 284 (71 × 4)
```

### Check daemon state
```bash
# View daemon startup logs
journalctl -u sms-daemon --no-pager | grep -A 100 "SMS Daemon.*starting" | grep -E "(Found|Cached|no SIM|Starting DUAL)"

# Current processing count (live)
journalctl -u sms-daemon -n 50 | grep "Processing.*modems"

# Check for SIM-less modems
journalctl -u sms-daemon | grep "⚠️.*no SIM"

# Check daemon status
systemctl status sms-daemon
```

### Check for USB errors
```bash
# USB enumeration errors
dmesg | grep -i "usb.*error\|hub.*error" | tail -50

# Device descriptor read failures (sign of enumeration issues)
dmesg | grep "device descriptor read" | tail -20

# Over-current or power issues
dmesg | grep -i "over-current\|power" | tail -20
```

### Check database sync state
```bash
# Total SIMs in inventory
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM sims;"

# Active modems (with SIM detected)
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM modems WHERE current_iccid IS NOT NULL;"
```

## Power Considerations

**Estimated power draw**:
- Quectel EC25 peak: 10W per modem (USB spec: 2.5W, exceeds by 4×!)
- 71 modems peak: ~710W
- 95 modems peak (if all detected): ~950W
- Orange Pi base: ~10W

**Powered hub requirements**:
- ✅ Use externally powered USB hubs (not bus-powered)
- ✅ 7-port hubs: 12V/5A power supply (60W capacity)
- ✅ 4-port hubs: 5V/5A power supply (25W capacity)
- ⚠️ Verify all hubs have adequate power supplies connected

**Symptoms of insufficient power**:
- Random modem dropouts (enumeration then disappearance)
- USB device reset errors in dmesg
- Error -71 (protocol error) during enumeration
- Modems enumerate but fail AT command initialization
- Brown-out crashes or system instability

## Future Capacity Planning

**Current limits**:
- ⚠️ USB bandwidth: 480Mbps shared across 71 modems = 6.7Mbps/modem (adequate for SMS, tight for LTE)
- ⚠️ USB endpoints: 355 endpoints (71 × 5) nearing controller limits (~400-500)
- ⚠️ Hub cascade: 5 tiers (at USB 2.0 spec maximum)
- ⚠️ Missing 24 modems: System at capacity, cannot enumerate more

**To support all 95 modems**:

### Option 1: Add Second Orange Pi (Recommended)
- Split load: 47-48 modems per system
- Pros: Simple, proven, no hardware changes to existing system
- Cons: Needs second daemon instance, more complex monitoring
- **Cost**: ~$100-150 (Orange Pi + microSD + case)

### Option 2: PCIe USB 3.0 Card
- Add PCIe USB 3.0 card to Orange Pi (if PCIe slot available)
- Pros: 10× bandwidth, 2× endpoint capacity, separate controller
- Cons: Orange Pi may lack PCIe slot, driver compatibility
- **Cost**: ~$30-50

### Option 3: Reduce Modem Interfaces
- Disable DM (If 0) and GPS (If 1) interfaces in EC25 firmware
- Reduces from 5 → 3 interfaces per modem
- Frees endpoints: 71 × 2 interfaces = 142 endpoints saved
- Pros: No hardware changes, works with existing system
- Cons: Lose diagnostic and GPS capabilities, firmware reflash needed
- **Cost**: $0 (firmware change only)

### Option 4: Simplify Hub Topology
- Reduce from 5-tier to 4-tier cascade
- Requires redesigning physical hub layout
- Pros: Better reliability, lower enumeration failure rate
- Cons: Major physical rewiring, may need more powerful aggregation hubs
- **Cost**: ~$200-300 (new hub layout)

**Recommendation**: **Option 1** (second Orange Pi) is the most pragmatic solution with lowest risk.

## Debugging Checklist

When modem count drops or modems go missing:

- [ ] Check USB detection: `lsusb | grep -i quectel | wc -l` → expect 71+
- [ ] Check ttyUSB ports: `ls /dev/ttyUSB* | wc -l` → expect count × 4
- [ ] Check USB errors: `dmesg | grep -i "usb.*error" | tail -50`
- [ ] Check daemon logs: `journalctl -u sms-daemon -n 100`
- [ ] Verify power supplies on all USB hubs (LEDs lit, voltage stable with multimeter)
- [ ] Physical inspection: count modem LEDs, check for loose cables
- [ ] Restart daemon: `systemctl restart sms-daemon`
- [ ] If persistent, reboot Orange Pi: `systemctl reboot`
- [ ] If still failing, check hub topology: `lsusb -t | less`

## References

- Complete USB topology explanation: [usb-topology-explained.md](usb-topology-explained.md) ← **Read this for deep dive**
- Investigation plan: [SIM_DETECTION_INVESTIGATION.md](../SIM_DETECTION_INVESTIGATION.md)
- Orange Pi documentation: [docs/deployment/orange-pi-setup.md](deployment/orange-pi-setup.md)
- Daemon architecture: [orange-pi-daemon/README.md](../orange-pi-daemon/README.md)
- Quectel EC25 datasheet: Quectel_EC2x_Series_Hardware_Design_V1.3.pdf
- USB 2.0 specification: USB_2.0_specification.pdf
