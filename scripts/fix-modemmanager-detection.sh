#!/usr/bin/env bash
# Fix ModemManager detection for 100 EC25 modems
# Problem: ModemManager only detects 14 out of 92 USB modems due to QMI initialization errors

set -e

echo "=== ModemManager Multi-Modem Fix ==="
echo ""
echo "Current status:"
echo "USB modems: $(lsusb | grep -c 'EC25')"
echo "ModemManager sees: $(mmcli -L 2>/dev/null | grep -c Modem || echo 0)"
echo ""

# Solution 1: Increase ModemManager timeouts and parallel probing
echo "1. Configuring ModemManager for 100 modems..."
cat > /etc/ModemManager/ModemManager.conf << EOF
[ModemManager]
# Increase timeouts for QMI initialization
PPPEchoInterval=30
PPPEchoFailure=10
# Allow more parallel probing
MaxProbes=100
ProbeTimeout=30
EOF

# Solution 2: Reset QMI state for all modems
echo "2. Resetting QMI state for all modems..."
systemctl stop ModemManager
sleep 2

# Reset QMI devices
for qmi in /dev/cdc-wdm*; do
    if [ -e "$qmi" ]; then
        echo "Resetting $qmi"
        # Send QMI reset command
        echo -ne '\x01\x00\x00\x00\x00\x00\x00\x00\x23\x00\x00\x00' > "$qmi" 2>/dev/null || true
    fi
done

# Solution 3: Load modems in smaller batches
echo "3. Loading modems in batches..."

# Function to enable a batch of modems
enable_modem_batch() {
    local start=$1
    local end=$2
    local count=0
    
    for dev in /sys/bus/usb/devices/1-*/; do
        if grep -q "2c7c" "$dev/idVendor" 2>/dev/null; then
            count=$((count + 1))
            if [ $count -ge $start ] && [ $count -le $end ]; then
                echo "Enabling modem $count: $(basename $dev)"
                echo "$(basename $dev)" > /sys/bus/usb/drivers/usb/bind 2>/dev/null || true
            fi
        fi
    done
}

# Unbind all modems first
echo "Unbinding all modems..."
for dev in /sys/bus/usb/devices/1-*/; do
    if grep -q "2c7c" "$dev/idVendor" 2>/dev/null; then
        echo "$(basename $dev)" > /sys/bus/usb/drivers/usb/unbind 2>/dev/null || true
    fi
done

# Start ModemManager
echo "Starting ModemManager..."
systemctl start ModemManager
sleep 5

# Load modems in batches of 20
echo "Loading modems in batches of 20..."
for i in 0 20 40 60 80; do
    echo "Loading batch: modems $((i+1)) to $((i+20))"
    enable_modem_batch $((i+1)) $((i+20))
    sleep 10
    echo "Currently detected: $(mmcli -L 2>/dev/null | grep -c Modem || echo 0) modems"
done

# Solution 4: Force ModemManager to rescan
echo ""
echo "4. Final scan..."
mmcli --scan-modems
sleep 10

# Show results
echo ""
echo "=== Results ==="
echo "USB modems connected: $(lsusb | grep -c 'EC25')"
echo "ModemManager now sees: $(mmcli -L 2>/dev/null | grep -c Modem || echo 0)"
mmcli -L

echo ""
echo "If still having issues, try:"
echo "1. Power cycle USB hubs"
echo "2. Increase ModemManager debug: mmcli --set-logging=DEBUG"
echo "3. Check dmesg for USB errors: dmesg | grep -i usb | tail"