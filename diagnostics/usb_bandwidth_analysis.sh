#!/bin/bash

# USB Bandwidth and Protocol Analysis
# Monitor USB bottlenecks and enumeration issues

echo "=== USB Bandwidth Analysis ==="
echo "Timestamp: $(date)"
echo

# 1. USB tree topology analysis
echo "USB Tree Topology:"
if command -v lsusb >/dev/null 2>&1; then
    lsusb -t
    echo
    
    # Count devices per controller
    echo "Device Count per USB Controller:"
    lsusb | awk '{print $2}' | sort | uniq -c | \
        while read count bus; do
            echo "Bus $bus: $count devices"
        done
else
    echo "lsusb not available"
fi
echo

# 2. USB bandwidth utilization
echo "USB Bandwidth Monitoring:"
# Monitor for 10 seconds to get average bandwidth usage
if [ -d /sys/kernel/debug/usb/usbmon ]; then
    echo "USB traffic monitoring (10 seconds)..."
    timeout 10 cat /sys/kernel/debug/usb/usbmon/0u 2>/dev/null | \
        head -100 | awk '
        BEGIN {bytes=0; packets=0}
        {bytes+=$6; packets++}
        END {
            if (packets > 0) {
                print "Packets: " packets
                print "Average packet size: " int(bytes/packets) " bytes"
                print "Total bytes/10s: " bytes
                print "Estimated bandwidth: " int(bytes*8/10/1024) " Kbps"
            }
        }' || echo "USB monitoring not available (need root access)"
else
    echo "USB monitoring not available (/sys/kernel/debug/usb/usbmon not found)"
fi
echo

# 3. USB enumeration errors
echo "USB Enumeration Errors (last 1000 lines):"
dmesg | grep -i "usb.*enum\|usb.*connect\|usb.*disconnect\|device descriptor" | tail -20
echo

# 4. USB reset and timeout events
echo "USB Protocol Errors:"
dmesg | grep -E "usb.*reset|usb.*timeout|usb.*stall|usb.*babble" | tail -15
echo

# 5. Hub-specific issues
echo "USB Hub Status Analysis:"
for hub_dir in /sys/bus/usb/devices/usb*; do
    if [ -d "$hub_dir" ]; then
        hub_name=$(basename "$hub_dir")
        
        # Check if it's actually a hub
        if [ -f "$hub_dir/bDeviceClass" ]; then
            device_class=$(cat "$hub_dir/bDeviceClass" 2>/dev/null)
            if [ "$device_class" = "09" ]; then  # Hub class
                echo "Hub $hub_name:"
                
                # Hub power status
                if [ -f "$hub_dir/power/runtime_status" ]; then
                    power_status=$(cat "$hub_dir/power/runtime_status")
                    echo "  Power: $power_status"
                fi
                
                # Count connected devices
                connected_devices=$(ls "$hub_dir" | grep -E "^[0-9]+-[0-9]+$" | wc -l)
                echo "  Connected devices: $connected_devices"
                
                # Hub speed
                if [ -f "$hub_dir/speed" ]; then
                    speed=$(cat "$hub_dir/speed")
                    echo "  Speed: $speed Mbps"
                fi
                echo
            fi
        fi
    fi
done

# 6. Bandwidth per device analysis
echo "High-Bandwidth USB Devices:"
lsusb -v 2>/dev/null | grep -B5 -A5 "wMaxPacketSize\|bInterval" | \
    grep -E "Bus|Device|wMaxPacketSize|bInterval" | \
    paste - - - | sort -k3 -nr | head -10 || echo "Detailed USB info not available"
echo

# 7. USB error counters
echo "USB Error Statistics:"
find /sys/bus/usb/devices -name "error_count" 2>/dev/null | \
    while read error_file; do
        device=$(dirname "$error_file" | xargs basename)
        errors=$(cat "$error_file" 2>/dev/null)
        if [ "$errors" -gt 0 ]; then
            echo "$device: $errors errors"
        fi
    done

# 8. Real-time USB activity monitoring
echo "USB Activity Monitoring (real-time sample):"
if [ -f /proc/bus/usb/devices ]; then
    echo "Active USB transactions:"
    grep -E "^[TDS]:" /proc/bus/usb/devices 2>/dev/null | head -10
else
    echo "/proc/bus/usb/devices not available"
fi