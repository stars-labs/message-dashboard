# Modem Inventory Guide

## Files

1. **[modem-inventory-2026-03-09.csv](modem-inventory-2026-03-09.csv)** - Basic inventory
2. **[modem-inventory-with-hub-paths.csv](modem-inventory-with-hub-paths.csv)** - Full inventory with physical hub paths ⭐

## Column Definitions

### modem_index
- **What**: Daemon's internal index (0-73)
- **Source**: Daemon startup logs (when it calls `list_modems()`)
- **Stability**: ❌ **NOT FIXED** - Changes every daemon restart
- **Use**: Temporary reference during a single daemon session

### usb_bus
- **What**: Linux USB bus number (always "001" on Orange Pi)
- **Source**: `lsusb` command
- **Stability**: ✅ **FIXED** - Bus 001 is always the EHCI USB 2.0 controller
- **Use**: Identifies which USB controller (only one on Orange Pi)

### usb_device
- **What**: Linux USB device number (003, 004, 084, etc.)
- **Source**: `lsusb` command
- **Stability**: ❌ **NOT FIXED** - Changes on reboot/replug
- **Use**: Temporary reference in current boot session

### hub_path
- **What**: Physical USB port path through the hub cascade
- **Format**: `Dev001 → Dev057 → Dev060 → Dev062 → Port002`
- **Source**: Parsed from `lsusb -t` output
- **Stability**: ⚠️ **PARTIALLY FIXED** - Device numbers change, but port topology is fixed
- **Use**: Trace physical location of modem in hub tree

### imei
- **What**: International Mobile Equipment Identity (15 digits)
- **Source**: Burned into modem hardware (from `AT+CGSN`)
- **Stability**: ✅ **FIXED** - Never changes, unique per modem
- **Use**: **PRIMARY IDENTIFIER** for tracking modems across reboots

### iccid
- **What**: Integrated Circuit Card Identifier (18-20 digits)
- **Source**: Burned into SIM card (from `AT+CCID`)
- **Stability**: ✅ **FIXED** - Never changes, unique per SIM card
- **Use**: Identify which SIM is in which modem

### phone_number
- **What**: Phone number assigned to SIM
- **Source**: Database (user-entered or from `AT+CNUM`)
- **Stability**: ✅ **FIXED** - Tied to SIM card
- **Use**: Human-readable identifier

### operator
- **What**: Mobile network operator name
- **Source**: Modem network registration (from `AT+COPS`)
- **Stability**: ⚠️ **CHANGES** - Based on current network
- **Use**: Verify SIM is registered to correct carrier

## Example Entry Explained

```csv
43,001,084,Dev001 → Dev057 → Dev060 → Dev062 → Dev066 → Port004,869604084768463,89860117811049221139,+8617600419127,StarHub
```

**Breaking it down**:

| Column | Value | Meaning |
|--------|-------|---------|
| modem_index | 43 | Daemon numbered this modem as #43 (temporary) |
| usb_bus | 001 | On USB Bus 1 (Orange Pi's EHCI controller) |
| usb_device | 084 | Linux assigned device number 084 (temporary) |
| hub_path | Dev001 → Dev057 → Dev060 → Dev062 → Dev066 → Port004 | Physical path (see below) |
| imei | 869604084768463 | **Modem's permanent ID** ✅ |
| iccid | 89860117811049221139 | **SIM card's permanent ID** ✅ |
| phone_number | +8617600419127 | Phone number for this SIM |
| operator | StarHub | Connected to StarHub network |

### Hub Path Breakdown

```
Dev001  →  Dev057  →  Dev060  →  Dev062  →  Dev066  →  Port004
  ↓          ↓          ↓          ↓          ↓           ↓
Root     Primary   Secondary  Aggregation  Modem      Physical
Hub      Distrib.  Distrib.   Hub (7-port) Hub        Port #4
         (4-port)  (4-port)               (4-port)
```

**Physical Location**:
1. Start at Orange Pi's USB root (Dev001)
2. Go to primary distribution hub (Dev057) - the first hub connected
3. Branch to secondary hub (Dev060) - Branch B
4. Connect to 7-port aggregation hub (Dev062)
5. Connect to 4-port modem hub (Dev066)
6. Modem is plugged into **Port 4** of Dev066

**Important**: The device numbers (057, 060, 062, 066, 084) will change on reboot, but the **PORT NUMBERS** and **HUB TOPOLOGY** remain the same!

## How to Use This Inventory

### Find a Modem by IMEI

If you know the IMEI:
```bash
grep "869604084768463" modem-inventory-with-hub-paths.csv
```

Returns the full row with phone number, hub path, etc.

### Find All Modems on a Specific Hub

To find all modems under hub Dev062:
```bash
grep "Dev062" modem-inventory-with-hub-paths.csv
```

### Track a Modem Across Reboots

1. **Before reboot**: Note the IMEI (e.g., 869604084768463)
2. **After reboot**: Search for that IMEI
3. The modem_index and usb_device will be different
4. The hub_path device numbers will change, but port structure stays the same
5. The IMEI, ICCID, and phone number remain identical

### Physically Locate a Modem

Given this path:
```
Dev001 → Dev057 → Dev060 → Dev062 → Dev066 → Port004
```

To physically find it:
1. Start at the Orange Pi
2. Find the first external hub (primary distribution)
3. Follow cable to second-tier hub (secondary distribution)
4. Follow cable to 7-port hub (aggregation)
5. Find 4-port hub connected to it (modem hub)
6. The modem is in **Port 4** of that final hub

**Tip**: Label each hub with its function (Primary, Secondary, Aggregation, Modem-01, etc.) to make physical location easier.

## Quick Reference

### ✅ FIXED (Persistent across reboots)
- **imei** - Use this as primary identifier
- **iccid** - Identifies the SIM card
- **phone_number** - Tied to SIM
- Port numbers in hub path (though device numbers change)

### ❌ TEMPORARY (Changes on reboot)
- **modem_index** - Daemon's temporary numbering
- **usb_device** - Linux's temporary device number
- Device numbers in hub_path (Dev057, Dev084, etc.)

### ⚠️ BEST PRACTICE
Always use **IMEI** to identify modems. Everything else is either temporary or derived from the IMEI/ICCID pairing.

## Updating the Inventory

To capture current state after a reboot:

```bash
# On Orange Pi:
ssh root@10.171.150.102 "lsusb -t" > docs/usb-topology-$(date +%Y-%m-%d).txt

# Extract new device numbers:
journalctl -u sms-daemon -n 200 | grep "Cached modem" > /tmp/new-inventory.txt

# Run the merge script to update hub paths
# (Device numbers change, but IMEIs stay the same)
```

The IMEI→Phone mapping remains stable, only USB device numbers need updating.
