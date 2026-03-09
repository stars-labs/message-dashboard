# USB Cascaded Hub Topology Explained

**Date**: 2026-03-09
**Hardware**: Orange Pi with 73 Quectel EC25 modems
**Data Source**: `lsusb -t` output

## Understanding the USB Tree Structure

The USB subsystem organizes devices in a **tree hierarchy**, similar to a file system. At the root is the **USB Host Controller** (the Orange Pi's USB chip), and devices branch out through **hubs**.

### Reading the lsusb -t Output

Each line shows:
```
|__ Port XXX: Dev YYY, If Z, Class=ClassName, Driver=driver_name, Speed
```

- **Port**: Physical port number on the parent hub
- **Dev**: USB device number assigned by Linux (not stable across reboots)
- **If**: Interface number (modems have 5 interfaces: 0-4)
- **Class**: USB device class (Hub, Vendor Specific, etc.)
- **Driver**: Kernel driver handling this interface
- **Speed**: 480M = USB 2.0 High Speed (480 Mbps)

## The Complete Topology

### Layer 0: Orange Pi USB Host Controller

```
Bus 001 (EHCI USB 2.0 controller)
└─ Root Hub (Dev 001) - 480 Mbps
```

**EHCI** = Enhanced Host Controller Interface (USB 2.0 spec)
The Orange Pi has a single USB 2.0 controller with 1 root port.

### Layer 1: Primary Distribution Hub

```
Root Hub Port 1
└─ Dev 057: Terminus 4-port Hub
     ├─ Port 2: Dev 058 (4-port hub)
     ├─ Port 3: Dev 059 (4-port hub) ← Main modem cascade
     └─ Port 4: Dev 060 (4-port hub) ← Main modem cascade
```

**Purpose**: Splits the single root port into 4 ports to create two independent modem branches.

**Manufacturer**: Terminus Technology (common USB hub chip maker)

### Layer 2: Secondary Distribution Hubs

#### Branch A (via Dev 059 Port 3)
```
Dev 059 (4-port hub)
├─ Port 2: Dev 061 (7-port hub) → 5× 4-port hubs → ~15 modems
├─ Port 3: Dev 063 (7-port hub) → 6× 4-port hubs → ~20 modems
└─ Port 4: Dev 067 (7-port hub) → 6× 4-port hubs → ~15 modems
```

#### Branch B (via Dev 060 Port 4)
```
Dev 060 (4-port hub)
├─ Port 1: Dev 062 (7-port hub) → 6× 4-port hubs → ~16 modems
└─ Port 2: Dev 065 (7-port hub) → 6× 4-port hubs → ~16 modems
```

**Key observation**: Layer 2 uses **7-port hubs** to maximize port count before the next cascade level.

### Layer 3: Aggregation Hubs (7-port hubs)

Example: **Dev 061** (7-port hub under Dev 059)

```
Dev 061 (7-port hub)
├─ Port 2: Dev 064 (4-port hub) → 3 modems
├─ Port 3: Dev 068 (4-port hub) → 2 modems
├─ Port 4: Dev 074 (4-port hub) → 1 modem
├─ Port 5: Dev 085 (4-port hub) → 3 modems
└─ Port 6: Dev 100 (4-port hub) → 4 modems
```

**Total under Dev 061**: 5 hubs × ~3 modems each = 13 modems

Each 7-port hub connects to **5-6 smaller 4-port hubs** which hold the actual modems.

### Layer 4: Modem Hubs (4-port hubs)

Example: **Dev 064** (4-port hub under Dev 061)

```
Dev 064 (4-port hub)
├─ Port 2: Dev 070 (Quectel EC25 modem)
│    ├─ If 0: option (ttyUSB*0 - DM/diagnostic)
│    ├─ If 1: option (ttyUSB*1 - GPS/NMEA)
│    ├─ If 2: option (ttyUSB*2 - AT commands) ← Daemon uses this
│    ├─ If 3: option (ttyUSB*3 - PPP data)
│    └─ If 4: qmi_wwan (wwan* - QMI network interface)
├─ Port 3: Dev 079 (Quectel EC25 modem) - same 5 interfaces
└─ Port 4: Dev 093 (Quectel EC25 modem) - same 5 interfaces
```

Each 4-port hub typically connects **2-4 modems** (not all ports populated).

## Key Design Principles

### 1. **4-Tier Cascade** (Maximum per USB 2.0 spec)

```
Tier 1: Root Hub (1 device)
Tier 2: Primary distribution (1 hub → 4 ports)
Tier 3: Secondary distribution (3 hubs → 7 ports each)
Tier 4: Aggregation (6 hubs → 7 ports → 4-port hubs)
Tier 5: Modems (20+ hubs → 4 ports each → 73 modems)
```

**USB 2.0 Limit**: Maximum 5 tiers (127 devices total)
**Current usage**: 5 tiers, 73 modems + ~30 hubs = ~103 devices ✅

### 2. **Balanced Load Distribution**

The topology splits into **2 main branches** early (Dev 059 and Dev 060):
- Branch A: ~50 modems
- Branch B: ~23 modems

This prevents overloading a single upstream hub path.

### 3. **Mix of Hub Sizes**

- **Layer 2-3**: 7-port hubs (maximize port count)
- **Layer 4**: 4-port hubs (cheaper, sufficient for 2-4 modems each)

### 4. **Hub Chip Models**

From `lsusb` output:
- **Terminus Technology Inc. Hub** (ID 1a40:0101) - 4-port hubs
- **Terminus Technology Inc. FE 2.1 7-port Hub** (ID 1a40:0201) - 7-port hubs

Both are common, inexpensive USB 2.0 hub controllers.

## Bandwidth Considerations

### Theoretical Bandwidth

```
USB 2.0 High Speed: 480 Mbps (60 MB/s)
Per modem (SMS only): ~100 Kbps average, ~1 Mbps peak
73 modems peak: 73 MB/s > 60 MB/s ⚠️
```

**Problem**: If all modems transmit simultaneously, they **exceed** USB 2.0 bandwidth!

**Reality**: SMS traffic is bursty and low-volume:
- Average: ~1-10 messages/second across all modems
- Each SMS: ~200 bytes
- Total: ~2 KB/s = 0.016 Mbps (negligible)

**Verdict**: **No bandwidth bottleneck** for SMS workload. Bandwidth would be a concern if modems were doing LTE data transfers.

### Bandwidth Sharing in Cascade

Each tier shares bandwidth with all children:

```
Root Hub (480 Mbps)
├─ Dev 057 Hub (480 Mbps shared across 4 ports = 120 Mbps per port)
    ├─ Dev 059 Hub (120 Mbps shared across 3 active ports = 40 Mbps per port)
        ├─ Dev 061 Hub (40 Mbps shared across 5 active ports = 8 Mbps per port)
            ├─ Dev 064 Hub (8 Mbps shared across 3 modems = 2.7 Mbps per modem)
```

**Worst-case modem bandwidth**: ~2.7 Mbps
**SMS requirement**: ~100 Kbps
**Margin**: 27× overhead ✅

## Power Delivery

### USB 2.0 Power Spec

- **Per port**: 500 mA @ 5V = 2.5W maximum
- **Quectel EC25 draw**: 2A @ 5V = 10W peak (4× spec!)

### Powered Hubs Required

**Why**: Modems draw more power than USB spec allows.

**Solution**: All hubs must be **externally powered** (not bus-powered):
- 7-port hubs: 12V/5A power supplies (60W capacity)
- 4-port hubs: 5V/5A power supplies (25W capacity)

**Current setup**:
- 73 modems × 10W = **730W theoretical peak**
- Actual average: ~150-200W (modems idle most of the time)

## Practical Implications

### 1. **Why Only 73 Modems Detected (Expected 78)?**

**Likely causes**:
- **Hub port exhaustion**: 100 leaf ports available, 78 modems attempted, but some hubs may be daisy-chained incorrectly
- **Power delivery limits**: Insufficient power on some hub branches causes brown-outs
- **USB endpoint limits**: Each modem uses 5 interfaces. 73 × 5 = 365 endpoints, nearing USB controller's ~400-500 endpoint limit

### 2. **Why This Topology Works**

✅ **Low bandwidth requirements** (SMS only)
✅ **Well-distributed load** (2 main branches)
✅ **Externally powered hubs** (sufficient power delivery)
✅ **Within USB tier limits** (5 tiers max, using 5)

### 3. **Scaling Limitations**

To exceed 80 modems, you'd need:
- **Second Orange Pi** with separate USB controller
- **PCIe USB 3.0 card** (10× bandwidth, 2× endpoint capacity)
- **Reduce modem interfaces** (disable DM/GPS to free endpoints)

## Troubleshooting with lsusb -t

### Check for Missing Hubs

```bash
lsusb -t | grep "Class=Hub" | wc -l
# Should see ~30 hubs
```

### Find Modems Under Specific Hub

```bash
lsusb -t | grep -A 50 "Dev 061"
# Shows all devices under Dev 061 (7-port hub)
```

### Verify All Modems Have 5 Interfaces

```bash
lsusb -t | grep "2c7c:0125" | wc -l
# Should be 73 × 5 = 365 lines
```

### Check for USB Errors

```bash
dmesg | grep -i 'usb.*error\|hub.*error'
# Look for device descriptor errors, over-current, etc.
```

## Visual Summary

```
Orange Pi USB 2.0 Controller (480 Mbps)
 │
 └─ 4-port Hub (Dev 057) ← Entry point
     ├─ [Empty]
     ├─ Branch A (Dev 059)
     │   ├─ 7-port Hub (Dev 061) → 5× 4-port hubs → 13 modems
     │   ├─ 7-port Hub (Dev 063) → 6× 4-port hubs → 20 modems
     │   └─ 7-port Hub (Dev 067) → 6× 4-port hubs → 15 modems
     └─ Branch B (Dev 060)
         ├─ 7-port Hub (Dev 062) → 6× 4-port hubs → 16 modems
         └─ 7-port Hub (Dev 065) → 6× 4-port hubs → 16 modems

Total: 73 modems across ~30 hubs in 5-tier cascade
```

## References

- Full USB tree: [usb-topology-2026-03-09.txt](usb-topology-2026-03-09.txt)
- USB 2.0 specification: USB_2.0_specification.pdf (Section 4.1: Hub Topology)
- Terminus hub datasheets: FE2.1 series
- Quectel EC25 hardware design guide: Section 3.3 (USB Interface)
