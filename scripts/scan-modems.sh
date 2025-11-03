#!/bin/bash

# Manual modem scanning script for ModemManager
# Use this when ModemManager fails to detect all modems automatically

echo "=========================================="
echo "Manual Modem Detection Script"
echo "=========================================="
echo ""

# First, check current ModemManager status
echo "1. Current ModemManager Status"
echo "-------------------------------"
systemctl status ModemManager --no-pager | head -10
echo ""

# Count USB devices
echo "2. USB Device Count"
echo "-------------------"
USB_COUNT=$(lsusb | grep -E "(Quectel|2c7c|05c6)" | wc -l)
echo "Found $USB_COUNT Quectel USB devices"
echo ""

# Count ttyUSB devices
echo "3. Serial Port Count"
echo "--------------------"
TTY_COUNT=$(ls /dev/ttyUSB* 2>/dev/null | wc -l)
echo "Found $TTY_COUNT /dev/ttyUSB* devices"
echo ""

# Check current modem detection
echo "4. Currently Detected Modems"
echo "----------------------------"
CURRENT_MODEMS=$(mmcli -L 2>/dev/null | wc -l)
echo "ModemManager has detected: $CURRENT_MODEMS modems"
mmcli -L 2>/dev/null | head -10
echo ""

# Try manual scan
echo "5. Attempting Manual Modem Scan"
echo "--------------------------------"

# Stop ModemManager
echo "Stopping ModemManager..."
systemctl stop ModemManager
sleep 2

# Start ModemManager with verbose logging
echo "Starting ModemManager with verbose logging..."
MM_FILTER_POLICY=DEFAULT MM_PROBE_TIMEOUT=120 /nix/store/*/bin/ModemManager --debug --filter-policy=DEFAULT --test-quick-suspend-resume &
MM_PID=$!
echo "ModemManager started with PID: $MM_PID"

# Wait for initialization
echo "Waiting for ModemManager to initialize (30 seconds)..."
sleep 30

# Check detection progress
echo ""
echo "6. Detection Progress"
echo "---------------------"
for i in {1..10}; do
    DETECTED=$(mmcli -L 2>/dev/null | wc -l)
    echo "Attempt $i: Detected $DETECTED modems"

    if [ "$DETECTED" -ge "$((USB_COUNT - 5))" ]; then
        echo "✅ Successfully detected most modems!"
        break
    fi

    sleep 5
done

# Final count
echo ""
echo "7. Final Results"
echo "----------------"
FINAL_COUNT=$(mmcli -L 2>/dev/null | wc -l)
echo "Total modems detected: $FINAL_COUNT / $USB_COUNT USB devices"

if [ "$FINAL_COUNT" -lt "$((USB_COUNT / 2))" ]; then
    echo ""
    echo "⚠️  Detection seems incomplete. Troubleshooting tips:"
    echo "1. Check dmesg for USB errors: dmesg | grep -E 'usb|ttyUSB' | tail -20"
    echo "2. Check ModemManager logs: journalctl -u ModemManager -n 50"
    echo "3. Try resetting USB hubs if connected"
    echo "4. Consider using mmcli --scan-modems to force a rescan"
else
    echo "✅ Detection successful!"
fi

echo ""
echo "To make changes permanent, stop this manual instance and restart the service:"
echo "  kill $MM_PID"
echo "  systemctl start ModemManager"