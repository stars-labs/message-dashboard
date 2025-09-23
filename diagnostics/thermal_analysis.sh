#!/bin/bash

# Thermal Analysis for USB Modem Array
# Monitor heat-related issues and thermal throttling

echo "=== Thermal Analysis ==="
echo "Timestamp: $(date)"
echo

# 1. CPU thermal status
echo "CPU Thermal Status:"
if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
    for zone in /sys/class/thermal/thermal_zone*; do
        if [ -f "$zone/temp" ]; then
            zone_name=$(basename $zone)
            temp=$(cat $zone/temp)
            temp_c=$((temp / 1000))
            echo "$zone_name: ${temp_c}°C"
            
            # Check throttling status
            if [ -f "$zone/policy" ]; then
                policy=$(cat $zone/policy)
                echo "  Policy: $policy"
            fi
        fi
    done
else
    echo "No thermal zones found"
fi
echo

# 2. Check for thermal throttling in kernel messages
echo "Thermal Throttling Events (last 24h):"
dmesg | grep -i "thermal\|throttl\|overheat" | \
    awk '{print strftime("%Y-%m-%d %H:%M:%S", systime()) " " $0}' | tail -20
echo

# 3. Monitor USB device temperatures (if available through sysfs)
echo "USB Device Thermal Status:"
for device in /sys/bus/usb/devices/*; do
    if [ -f "$device/power/runtime_status" ]; then
        device_name=$(basename $device)
        runtime_status=$(cat $device/power/runtime_status 2>/dev/null)
        
        # Look for thermal-related attributes
        if [ -f "$device/temp" ]; then
            temp=$(cat $device/temp 2>/dev/null)
            echo "$device_name: ${temp}°C, Status: $runtime_status"
        fi
    fi
done
echo

# 4. Check system load and power consumption patterns
echo "System Load vs Temperature Correlation:"
uptime
echo "Load average vs thermal zones:"
cat /proc/loadavg
echo

# 5. Monitor frequency scaling (thermal throttling indicator)
echo "CPU Frequency Scaling (Thermal Throttling Check):"
if [ -d /sys/devices/system/cpu/cpu0/cpufreq ]; then
    for cpu in /sys/devices/system/cpu/cpu*/cpufreq; do
        if [ -f "$cpu/scaling_cur_freq" ]; then
            cpu_name=$(echo $cpu | sed 's/.*cpu\([0-9]*\).*/CPU\1/')
            cur_freq=$(cat $cpu/scaling_cur_freq 2>/dev/null)
            max_freq=$(cat $cpu/cpuinfo_max_freq 2>/dev/null)
            if [ -n "$cur_freq" ] && [ -n "$max_freq" ]; then
                throttle_pct=$(echo "scale=1; (1 - $cur_freq/$max_freq) * 100" | bc 2>/dev/null)
                echo "$cpu_name: Current ${cur_freq}kHz / Max ${max_freq}kHz (${throttle_pct}% throttled)"
            fi
        fi
    done
fi
echo

# 6. Environment temperature monitoring
echo "Environmental Monitoring:"
# Try to get ambient temperature from various sources
if command -v sensors >/dev/null 2>&1; then
    sensors 2>/dev/null | grep -E "temp|fan"
else
    echo "lm-sensors not installed - cannot read hardware sensors"
fi

# Check for cooling fans
echo "Fan Status:"
find /sys -name "*fan*" -type f 2>/dev/null | while read fan_file; do
    if [ -r "$fan_file" ]; then
        fan_value=$(cat "$fan_file" 2>/dev/null)
        echo "$(dirname $fan_file | sed 's/.*\///'): $fan_value"
    fi
done

# 7. Thermal history analysis
echo "USB Reset Events (thermal-related):"
journalctl --since "24 hours ago" --no-pager | \
    grep -i "usb.*reset\|thermal.*usb\|overheat" | tail -10