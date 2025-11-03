#!/bin/bash

# Verification script for ModemManager modem detection after deployment
# Usage: ./verify-modem-detection.sh

echo "=========================================="
echo "ModemManager Detection Verification"
echo "=========================================="
echo ""

HOST="root@203.116.95.146"

echo "1. ModemManager Service Status"
echo "------------------------------"
ssh $HOST 'systemctl status ModemManager --no-pager | head -15'
echo ""

echo "2. USB Device Count"
echo "-------------------"
USB_COUNT=$(ssh $HOST 'lsusb | grep -E "(Quectel|2c7c|05c6)" | wc -l')
echo "Total Quectel USB devices: $USB_COUNT"
echo ""

echo "3. Initial Modem Detection"
echo "--------------------------"
INITIAL_COUNT=$(ssh $HOST 'mmcli -L 2>/dev/null | wc -l')
echo "Initially detected: $INITIAL_COUNT modems"
echo ""

if [ "$INITIAL_COUNT" -lt "$((USB_COUNT / 2))" ]; then
    echo "4. Forcing Modem Scan"
    echo "---------------------"
    ssh $HOST 'mmcli --scan-modems'
    echo "Scan requested, waiting 10 seconds..."
    sleep 10

    AFTER_SCAN=$(ssh $HOST 'mmcli -L 2>/dev/null | wc -l')
    echo "After scan: $AFTER_SCAN modems detected"
    echo ""
fi

echo "5. Progressive Detection Check"
echo "------------------------------"
echo "Monitoring detection progress over 60 seconds..."
for i in {1..6}; do
    sleep 10
    COUNT=$(ssh $HOST 'mmcli -L 2>/dev/null | wc -l')
    echo "  ${i}0s: $COUNT modems detected"

    if [ "$COUNT" -ge "$((USB_COUNT - 5))" ]; then
        echo "  ✅ Successfully detected most modems!"
        break
    fi
done
echo ""

echo "6. Final Modem List (first 10)"
echo "-------------------------------"
ssh $HOST 'mmcli -L 2>/dev/null | head -10'
echo ""

FINAL_COUNT=$(ssh $HOST 'mmcli -L 2>/dev/null | wc -l')
echo "=========================================="
echo "Results:"
echo "  USB Devices: $USB_COUNT"
echo "  Modems Detected: $FINAL_COUNT"
echo "  Detection Rate: $((FINAL_COUNT * 100 / USB_COUNT))%"
echo ""

if [ "$FINAL_COUNT" -ge "$((USB_COUNT - 5))" ]; then
    echo "✅ ModemManager optimization successful!"
else
    echo "⚠️  Detection incomplete. May need manual intervention."
    echo ""
    echo "Troubleshooting:"
    echo "1. Check ModemManager logs: ssh $HOST 'journalctl -u ModemManager -n 50'"
    echo "2. Check for USB errors: ssh $HOST 'dmesg | grep -E \"usb|error\" | tail -20'"
    echo "3. Try manual script: scp scripts/scan-modems.sh $HOST:/tmp/ && ssh $HOST 'bash /tmp/scan-modems.sh'"
fi
echo "=========================================="