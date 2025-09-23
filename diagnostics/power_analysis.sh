#!/bin/bash

# USB Power Consumption Analysis Script
# Run on Orange Pi to monitor power-related USB issues

echo "=== USB Power Analysis ==="
echo "Timestamp: $(date)"
echo

# 1. Check USB hub power status
echo "USB Hub Power Status:"
for hub in /sys/bus/usb/devices/usb*; do
    if [ -f "$hub/power/runtime_status" ]; then
        hub_name=$(basename $hub)
        status=$(cat $hub/power/runtime_status 2>/dev/null)
        power_control=$(cat $hub/power/control 2>/dev/null)
        echo "$hub_name: Runtime=$status, Control=$power_control"
    fi
done
echo

# 2. Monitor USB device power consumption
echo "USB Device Power Draw:"
lsusb -v 2>/dev/null | grep -A5 -B5 "MaxPower\|bcdDevice\|Quectel" | \
    grep -E "(Bus|Device|MaxPower|Quectel)" | \
    while read line; do echo "  $line"; done
echo

# 3. Check for USB errors indicating power issues
echo "USB Power-Related Errors:"
dmesg | grep -i "usb.*power\|usb.*suspend\|usb.*reset\|over-current" | tail -20
echo

# 4. Monitor voltage levels if available
echo "System Power Status:"
if [ -d /sys/class/power_supply ]; then
    for ps in /sys/class/power_supply/*; do
        if [ -f "$ps/voltage_now" ]; then
            name=$(basename $ps)
            voltage=$(cat $ps/voltage_now 2>/dev/null)
            echo "$name: ${voltage}µV ($(echo "scale=2; $voltage/1000000" | bc)V)"
        fi
    done
fi
echo

# 5. Check USB hub current consumption
echo "USB Hub Current Draw Analysis:"
for device in /sys/bus/usb/devices/*; do
    if [ -f "$device/bConfigurationValue" ] && [ -f "$device/bMaxPower" ]; then
        device_name=$(basename $device)
        max_power=$(cat $device/bMaxPower 2>/dev/null)
        if [ "$max_power" -gt 0 ]; then
            echo "$device_name: ${max_power}mA"
        fi
    fi
done | sort -k2 -nr | head -20
echo

# 6. Real-time USB power monitoring
echo "Real-time USB Activity (30 seconds):"
timeout 30 usbmon 2>/dev/null | grep -E "Power|Reset|Suspend" || \
    echo "usbmon not available - install usbutils-dev"