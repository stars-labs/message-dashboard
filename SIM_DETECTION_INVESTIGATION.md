# SIM Detection Investigation Plan - SIM #14 (and 8 others)

## Problem Statement
9 SIMs are physically plugged into the USB hub but not being detected by the daemon:
- SIM slots: 14, 19, 46, 57, 62, 63, 71, 73, 91

### Current System State (from docs/usb_info.md)
- **Expected modems**: 95 (based on user SIM inventory)
- **Physically detected by USB**: 73 modems (as of 2026-03-09)
- **Modems with SIM cards (active)**: 70
- **Modems without SIM cards**: 2 (modem 7, 67)
- **Missing modems**: 22 modems (95 - 73 = 22 not detected)

### Hypothesis: These 9 SIMs are among the 22 missing modems
The fact that 22 modems are not detected by USB suggests a system-wide issue, not just these specific SIMs.

## System Architecture (Detection Flow)

```
Physical Modem → USB Port → /dev/ttyUSB* → AT Command Probe → Daemon Detection
     ↓              ↓            ↓                ↓                    ↓
   EC20         Hub Port    ttyUSB2,6,10...   "AT" command    ModemManager.list_modems()
```

### Detection Logic Chain (main.rs:159-229)

1. **Modem Discovery** (`modem_manager.list_modems()`)
   - Calls `at_modem.discover_modems()` (AT mode, default)
   - Scans `/dev/ttyUSB*` for EC20 pattern: ttyUSB2, ttyUSB6, ttyUSB10... (every 4th, offset 2)
   - Probes each port with `AT` command (1s timeout)
   - If AT responds with "OK" → modem detected

2. **ICCID Retrieval** (main.rs:168-223)
   - For each detected modem: `modem_manager.get_iccid(&modem_id)`
   - Tries multiple AT commands: `AT+QCCID`, `AT+CCID`, `AT+ICCID`
   - If ICCID found → added to `valid_modems` cache
   - If NO ICCID → logs warning "Modem X has no SIM card"

3. **IMEI Lookup** (main.rs:172-194)
   - Best-effort lookup via `get_device_details()`
   - Uses `AT+CGSN` command
   - Only for logging/diagnostics

### Key Code Points

#### at_modem.rs:107-173 - Discovery Logic
```rust
pub async fn discover_modems(&self) -> Result<Vec<String>> {
    // Scans /dev/ttyUSB* for pattern ttyUSB2, ttyUSB6, ttyUSB10...
    // EC20 AT ports are every 4th port starting at 2
    if num >= 2 && num % 4 == 2 {
        Some(format!("/dev/ttyUSB{}", num))
    }

    // Probes each port with AT command (1s timeout)
    match self.probe_port_with_error(&port_path).await {
        Ok(true) => ports.push(port_path),
        Ok(false) => debug!("Port exists but no AT response"),
        Err(e) => warn!("Port probe error"),
    }
}
```

#### at_modem.rs:176-184 - Probe Logic
```rust
async fn probe_port_with_error(&self, port: &str) -> Result<bool> {
    match self.send_at_command(port, "AT", Duration::from_millis(1000)).await {
        Ok(response) => Ok(response.contains("OK")),
        Err(e) => Err(e),
    }
}
```

#### at_modem.rs:337-347 - ICCID Retrieval
```rust
pub async fn get_iccid(&self, port: &str) -> Result<Option<String>> {
    // Try different ICCID commands (varies by modem)
    for cmd in &["AT+QCCID", "AT+CCID", "AT+ICCID"] {
        if let Ok(response) = self.send_at_command(port, cmd, self.timeout).await {
            if let Some(iccid) = Self::parse_iccid(&response) {
                return Ok(Some(iccid));
            }
        }
    }
    Ok(None)
}
```

## Phase 1: Root Cause Investigation

### Multi-Layer System Evidence Gathering

Following systematic debugging Phase 1.4 - we need diagnostic instrumentation at EACH component boundary:

#### Layer 1: Physical Hardware
**Check:** Are the 9 modems physically powered and connected to USB hub?
```bash
# On Orange Pi
lsusb  # Should show Quectel devices
dmesg | tail -100  # Check for USB enumeration errors
```

#### Layer 2: USB Device Detection
**Check:** Does Linux kernel detect the USB devices?
```bash
# On Orange Pi
ls -la /dev/ttyUSB* | wc -l  # Should show 4 ports per modem
# For ~95 modems → expect ~380 ttyUSB devices
# EC20 creates: ttyUSB0 (DM), ttyUSB1 (GPS), ttyUSB2 (AT), ttyUSB3 (PPP)
```

**Expected pattern for SIM #14:**
- If SIM #14 is supposed to be on modem at ttyUSB50, we should see:
  - /dev/ttyUSB48 (DM)
  - /dev/ttyUSB49 (GPS)
  - /dev/ttyUSB50 (AT) ← This is what daemon uses
  - /dev/ttyUSB51 (PPP)

#### Layer 3: AT Port Discovery
**Check:** Does `discover_modems()` find the ttyUSB2 port for this modem?
```rust
// Add instrumentation in at_modem.rs:107-173
// Log ALL ttyUSB ports found before filtering
// Log which ports match EC20 pattern (num % 4 == 2)
// Log which ports are probed
```

#### Layer 4: AT Command Probe
**Check:** Does the "AT" probe succeed?
```rust
// Add instrumentation in at_modem.rs:176-184
// Log exact AT command sent
// Log raw response received
// Log timeout/error details
```

**Possible failure modes:**
- Port exists but permission denied (unlikely, daemon runs as root)
- Port exists but no modem response (modem hung/crashed)
- Port exists but wrong baud rate (should be 115200)
- Port exists but ModemManager is holding it exclusively

#### Layer 5: ICCID Retrieval
**Check:** Does `AT+QCCID` return valid ICCID?
```rust
// Add instrumentation in at_modem.rs:337-347
// Log each ICCID command attempt (AT+QCCID, AT+CCID, AT+ICCID)
// Log raw response from modem
// Log parsing result
```

**Possible failure modes:**
- No SIM physically inserted (should see empty response)
- SIM not recognized (bad contact, damaged SIM)
- SIM initialization failed (AT+QCCID returns ERROR)
- Response parsing failed (unexpected format)

### Evidence Collection Commands

Run these on Orange Pi (203.116.95.146):

```bash
# 1. Check daemon logs for detection phase
journalctl -u sms-daemon -n 500 | grep -E "(Found.*modems|has no SIM|Cached modem)"

# 2. Check which ttyUSB ports exist
ls -la /dev/ttyUSB* | grep "ttyUSB[0-9]*2$"  # AT ports only (pattern: *2)

# 3. Manual AT probe for specific port (e.g., ttyUSB50 if SIM #14 should be there)
# Create test script: test_at_probe.sh
cat > /tmp/test_at_probe.sh << 'EOF'
#!/bin/bash
PORT=$1
stty -F $PORT 115200 cs8 -cstopb -parenb raw
echo -e "AT\r" > $PORT
timeout 2s cat $PORT
EOF
chmod +x /tmp/test_at_probe.sh

# Test specific ports
/tmp/test_at_probe.sh /dev/ttyUSB50  # Should output "OK" if working

# 4. Check ModemManager status (might be holding ports)
systemctl status ModemManager
mmcli -L  # List modems seen by ModemManager

# 5. Check USB errors
dmesg | grep -i "usb.*error"
```

## Phase 2: Pattern Analysis

### Find Working Examples
- Compare a working SIM (e.g., SIM #1-13) vs non-detected SIM #14
- Are working SIMs on specific USB hub ports?
- Are failing SIMs on specific USB hub ports?

### Compare Against Reference Documentation

**Quectel EC20 AT Command Manual:**
- Need to verify standard initialization sequence
- Check if there's required setup before AT+QCCID works
- Research if SIM needs time to initialize after power-on

**USB Hub Specifications:**
- Are there power budget constraints?
- Does the hub support 100+ USB devices?
- Check USB enumeration order

### Identify Differences
- USB port numbers: Are failing modems at high port numbers (>200)?
- Hub topology: Are they on different hub tiers?
- Timing: Do they enumerate later (daemon starts before ready)?

## Phase 3: Hypothesis Formation

**PRIMARY HYPOTHESIS (based on evidence):**

### H1: USB Enumeration Capacity Exceeded (Most Likely)
**Evidence:**
- 22 modems missing (95 expected - 73 detected = 22)
- System at USB tier limit (5 tiers, maximum allowed)
- Endpoint usage near capacity (365/400-500)
- This explains why MULTIPLE SIMs are affected, not just one

**Root Cause:**
- USB controller or hub cascade can't enumerate all 95 modems
- Physical limit reached at ~73 modems
- Some hubs may have insufficient power causing enumeration failures

**Test:**
```bash
# On Orange Pi
lsusb | grep -i quectel | wc -l  # Should show actual USB-detected count
dmesg | grep -i "usb.*error\|hub.*error" | tail -50  # Check for enumeration failures
ls /dev/ttyUSB* | wc -l  # Should be modem_count × 4
```

**If confirmed, solutions:**
1. Add second Orange Pi to split modem load (50 modems each)
2. Upgrade to PCIe USB 3.0 card (more endpoints, better bandwidth)
3. Reduce modem interfaces (disable DM/GPS in firmware to free endpoints)

---

### H2: Power Delivery Insufficient
**Evidence:**
- EC25 draws 10W peak (4× USB spec)
- 95 modems × 10W = 950W theoretical
- Some hub branches may lack adequate power supplies

**Symptoms:**
- Modems enumerate initially but drop out
- Random resets in dmesg
- Brown-out errors

**Test:**
```bash
dmesg | grep -i "over-current\|power" | tail -50
# Check hub power supply voltages physically
```

---

### H3: Daemon Timing Issue (Less Likely)
**Evidence:**
- Daemon builds modem list once at startup (main.rs:159-229)
- No re-scan mechanism
- If modems enumerate slowly, daemon might miss them

**Test:**
```bash
# Restart daemon after system has been up for a while
systemctl restart sms-daemon
journalctl -u sms-daemon -n 200 | grep "Found.*modems"
```

---

### H4: SIM Initialization Delay (Specific SIMs Only)
**Evidence:**
- Some SIMs need 3-10s to initialize after power-on
- AT+QCCID fails if called too early
- Current code has 5s timeout, single attempt

**Test:**
- Add retry logic with 2s delay between attempts
- Log ICCID responses for all modems

**Less likely because**: Affects 22 modems (too many for random SIM timing issues)

---

### H5: Hub Topology Issue
**Evidence:**
- 5-tier cascade at USB spec maximum
- Some modems may be on overloaded hub branches

**Test:**
```bash
lsusb -t | grep "Class=Hub" | wc -l  # Count hubs
lsusb -t | grep "2c7c:0125"  # Find Quectel modems in tree
# Check if missing modems are on specific hub branches
```

## Research: Official Standards & Key Findings

### USB 2.0 Topology Limits (from docs/usb-topology-explained.md)
- **Maximum tiers**: 5 tiers (USB 2.0 spec limit)
- **Current usage**: 5 tiers (at maximum!)
  - Tier 1: Root Hub
  - Tier 2: Primary 4-port distribution hub
  - Tier 3: Secondary 4-port/7-port hubs
  - Tier 4: 7-port aggregation hubs
  - Tier 5: 4-port modem hubs with EC25 devices

- **Maximum devices**: 127 per bus (USB 2.0 spec)
- **Current usage**: 73 modems + ~30 hubs = ~103 devices (within limit ✅)

- **Bandwidth**: 480 Mbps shared (6.5 Mbps per modem theoretical)
  - SMS usage: ~100 Kbps per modem (adequate ✅)

- **USB Endpoints**: Each EC25 uses 5 interfaces
  - 73 modems × 5 = 365 endpoints
  - USB controller limit: ~400-500 endpoints
  - **Status**: Nearing capacity! ⚠️

### Power Considerations
- **Per modem draw**: Quectel EC25 peak = 2A @ 5V = 10W
- **USB 2.0 spec**: 500mA @ 5V = 2.5W per port
- **Modems exceed spec by 4×!** Must use powered hubs.
- **73 modems peak**: ~730W theoretical
- **Symptom of insufficient power**:
  - Random modem dropouts
  - USB device reset errors
  - Modems enumerate but fail AT initialization

### Quectel EC25 USB Interface Pattern
Each modem creates 4 sequential ttyUSB ports:
- ttyUSB*0 (If 0): DM/Diagnostic (not used)
- ttyUSB*1 (If 1): GPS/NMEA (not used)
- ttyUSB*2 (If 2): **AT Commands** ← Daemon uses this
- ttyUSB*3 (If 3): PPP data (not used)

**Discovery pattern in daemon**: ttyUSB2, ttyUSB6, ttyUSB10, ttyUSB14... (every 4th, offset 2)

### AT Command Standards (3GPP TS 27.007)
- **AT+QCCID**: Quectel-specific ICCID query
- **AT+CCID / AT+ICCID**: Standard alternatives
- **Response format**: `+QCCID: "89860..."` or raw ICCID
- **SIM initialization time**: Can take 3-10 seconds after power-on
- **Retry requirement**: Some SIMs need multiple attempts

## Next Steps

1. ✅ Document detection flow and failure points (DONE - this file)
2. ⏳ Gather evidence from all layers (Layer 1-5 diagnostics)
3. ⏳ Research official standards for EC20 and SIM initialization
4. ⏳ Form specific hypothesis based on evidence
5. ⏳ Test hypothesis with minimal change
6. ⏳ Implement fix if hypothesis confirmed

## References
- `/home/loki/code/stars-labs/message-dashboard/orange-pi-daemon/src/main.rs:159-229`
- `/home/loki/code/stars-labs/message-dashboard/orange-pi-daemon/src/modem_manager.rs:99-126`
- `/home/loki/code/stars-labs/message-dashboard/orange-pi-daemon/src/at_modem.rs:107-173`
