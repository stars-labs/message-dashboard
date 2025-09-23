#!/bin/bash

# EMI/RFI and Hardware Degradation Analysis
# Monitor electromagnetic interference and hardware health

echo "=== EMI/RFI and Hardware Degradation Analysis ==="
echo "Timestamp: $(date)"
echo

# 1. Hardware failure pattern analysis
echo "Hardware Failure Pattern Analysis:"
echo "USB device stability over time:"

# Get device uptime/connection time
if [ -d /sys/bus/usb/devices ]; then
    echo "USB device connection analysis:"
    for device in /sys/bus/usb/devices/*; do
        if [ -f "$device/idVendor" ] && [ -f "$device/idProduct" ]; then
            vendor=$(cat "$device/idVendor" 2>/dev/null)
            product=$(cat "$device/idProduct" 2>/dev/null)
            
            # Check if it's a Quectel modem (vendor ID 2c7c)
            if [ "$vendor" = "2c7c" ]; then
                device_name=$(basename "$device")
                
                # Check device state
                if [ -f "$device/authorized" ]; then
                    authorized=$(cat "$device/authorized")
                    echo "  $device_name: Authorized=$authorized"
                fi
                
                # Check power state
                if [ -f "$device/power/runtime_status" ]; then
                    power_status=$(cat "$device/power/runtime_status")
                    echo "    Power: $power_status"
                fi
                
                # Check for errors
                if [ -f "$device/error_count" ]; then
                    errors=$(cat "$device/error_count")
                    if [ "$errors" -gt 0 ]; then
                        echo "    Errors: $errors"
                    fi
                fi
            fi
        fi
    done
fi
echo

# 2. Signal quality degradation monitoring
echo "Signal Quality Analysis:"
# Use ModemManager to check signal quality patterns
if command -v mmcli >/dev/null 2>&1; then
    echo "Checking signal quality across modems (sample of 5):"
    modem_list=$(mmcli -L 2>/dev/null | grep "/org/freedesktop/ModemManager1/Modem/" | head -5)
    
    if [ -n "$modem_list" ]; then
        echo "$modem_list" | while read line; do
            modem_id=$(echo "$line" | awk '{print $1}')
            if [ -n "$modem_id" ]; then
                signal_info=$(mmcli -m "$modem_id" 2>/dev/null | grep -E "signal quality|access tech")
                if [ -n "$signal_info" ]; then
                    echo "  Modem $modem_id:"
                    echo "$signal_info" | sed 's/^/    /'
                fi
            fi
        done
    else
        echo "No modems found for signal analysis"
    fi
else
    echo "mmcli not available"
fi
echo

# 3. EMI-related kernel messages
echo "EMI/RFI Related Kernel Messages:"
dmesg | grep -E "usb.*noise|usb.*interference|signal.*integrity|crc.*error|usb.*babble" | tail -10
echo

# 4. USB error pattern analysis
echo "USB Error Pattern Analysis:"
echo "Recent USB errors by type:"
dmesg | grep -E "usb.*error" | awk '{print $NF}' | sort | uniq -c | sort -nr | head -10
echo

# 5. Hardware temperature monitoring (if available)
echo "Hardware Temperature Status:"
# Check for hardware sensors
if command -v sensors >/dev/null 2>&1; then
    sensors 2>/dev/null | grep -E "temp|fan" | head -10
else
    echo "lm-sensors not available"
fi

# Check CPU thermal throttling (EMI can cause overheating)
if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
    cpu_temp=$(cat /sys/class/thermal/thermal_zone0/temp)
    cpu_temp_c=$((cpu_temp / 1000))
    echo "CPU Temperature: ${cpu_temp_c}°C"
    
    if [ "$cpu_temp_c" -gt 70 ]; then
        echo "WARNING: High CPU temperature detected (potential EMI heating effect)"
    fi
fi
echo

# 6. RF interference detection
echo "RF Interference Detection:"
# Check for patterns in modem disconnections
echo "Modem disconnection pattern analysis:"
journalctl --no-pager -n 1000 | grep -E "usb.*disconnect|modem.*lost" | \
    awk '{print $1 " " $2 " " $3}' | sort | uniq -c | sort -nr | head -10

# Check for simultaneous failures (indicating EMI events)
echo "Simultaneous failure detection (within 1-minute windows):"
journalctl --no-pager -n 500 | grep "usb.*disconnect" | \
    awk '{print $1 " " $2}' | sort | uniq -c | \
    awk '$1 > 3 {print "Multiple failures at " $2 " " $3 ": " $1 " devices"}'
echo

# 7. Cable integrity analysis
echo "Cable Integrity Analysis:"
# Check for USB speed negotiation issues (cable degradation)
echo "USB speed negotiation issues:"
dmesg | grep -E "usb.*speed|usb.*negotiat|high.speed.*full.speed" | tail -10
echo

# 8. Power supply stability
echo "Power Supply Stability:"
# Check for voltage regulation issues
dmesg | grep -E "voltage|power.*unstable|brown.?out" | tail -5

# USB power-related resets
echo "USB power-related events:"
dmesg | grep -E "usb.*power.*reset|usb.*overcurrent|usb.*power.*fail" | tail -10
echo

# 9. Device enumeration failure analysis
echo "Device Enumeration Failure Analysis:"
# Check for failed device enumeration (sign of EMI/signal integrity issues)
echo "Device enumeration failures:"
dmesg | grep -E "device.*enumerat.*fail|unable.*enumerate|device.*not.*accepting" | tail -10
echo

# 10. Long-term degradation tracking
echo "Long-term Degradation Tracking:"
# System uptime vs modem count
uptime_days=$(uptime | awk '{print $3}' | sed 's/,//')
current_modems=$(lsusb | grep -c "2c7c" || echo "0")
echo "System uptime: $uptime_days"
echo "Current Quectel modems detected: $current_modems"

# Check for pattern of device losses over time
echo "Device loss pattern (from kernel log):"
dmesg | grep -E "usb.*disconnect" | grep "2c7c" | wc -l | \
    awk '{print "Total modem disconnections in kernel log: " $1}'

# 11. Spectrum analysis (if RF tools available)
echo "RF Spectrum Analysis:"
if command -v hackrf_info >/dev/null 2>&1; then
    echo "HackRF available for spectrum analysis"
elif command -v rtl_test >/dev/null 2>&1; then
    echo "RTL-SDR available for spectrum analysis" 
else
    echo "No RF analysis tools available (consider installing hackrf/rtl-sdr tools)"
fi

# 12. Check for correlated environmental factors
echo "Environmental Correlation Analysis:"
# Check if failures correlate with system load
echo "System load correlation:"
uptime

# Memory pressure (can indicate EMI-induced errors)
if [ -f /proc/meminfo ]; then
    grep -E "MemTotal|MemFree|Cached" /proc/meminfo | \
        awk '{printf "%-12s %s\n", $1, $2}'
fi