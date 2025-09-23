#!/bin/bash

# ModemManager and QMI Protocol Analysis
# Monitor ModemManager performance and bottlenecks

echo "=== ModemManager Analysis ==="
echo "Timestamp: $(date)"
echo

# 1. ModemManager process status
echo "ModemManager Process Status:"
if pgrep -f ModemManager >/dev/null; then
    mm_pid=$(pgrep -f ModemManager)
    echo "PID: $mm_pid"
    
    # CPU and memory usage
    ps -p $mm_pid -o pid,ppid,cpu,pmem,rss,vsz,time,cmd 2>/dev/null || echo "Process info not available"
    
    # Open file descriptors
    if [ -d "/proc/$mm_pid/fd" ]; then
        fd_count=$(ls /proc/$mm_pid/fd 2>/dev/null | wc -l)
        echo "Open file descriptors: $fd_count"
    fi
    
    # Memory maps
    if [ -f "/proc/$mm_pid/status" ]; then
        echo "Memory status:"
        grep -E "VmPeak|VmSize|VmRSS|VmData" /proc/$mm_pid/status 2>/dev/null
    fi
else
    echo "ModemManager is not running"
fi
echo

# 2. ModemManager version and configuration
echo "ModemManager Configuration:"
if command -v ModemManager >/dev/null 2>&1; then
    ModemManager --version 2>/dev/null || echo "Version not available"
fi

# Check for custom configuration
if [ -f /etc/ModemManager/ModemManager.conf ]; then
    echo "Custom configuration found:"
    cat /etc/ModemManager/ModemManager.conf
else
    echo "No custom ModemManager configuration"
fi
echo

# 3. D-Bus connection analysis
echo "D-Bus Analysis:"
if command -v busctl >/dev/null 2>&1; then
    echo "ModemManager D-Bus service status:"
    busctl status org.freedesktop.ModemManager1 2>/dev/null || echo "D-Bus service not found"
    
    echo "D-Bus connection count:"
    busctl list | grep -c "org.freedesktop.ModemManager1" || echo "0"
    
    # List all modem objects
    echo "Modem objects on D-Bus:"
    busctl tree org.freedesktop.ModemManager1 2>/dev/null | grep -c "/org/freedesktop/ModemManager1/Modem/" || echo "0"
else
    echo "busctl not available"
fi
echo

# 4. QMI-specific diagnostics
echo "QMI Protocol Analysis:"
# Check for QMI interfaces
qmi_devices=$(find /dev -name "cdc-wdm*" 2>/dev/null | wc -l)
echo "QMI devices (/dev/cdc-wdm*): $qmi_devices"

# Check for QMI utilities
if command -v qmicli >/dev/null 2>&1; then
    echo "qmicli available"
    # Test one device for QMI responsiveness
    first_qmi=$(find /dev -name "cdc-wdm*" 2>/dev/null | head -1)
    if [ -n "$first_qmi" ]; then
        echo "Testing QMI responsiveness on $first_qmi:"
        timeout 5 qmicli -d "$first_qmi" --get-service-version-info 2>/dev/null | head -5 || echo "QMI test failed or timed out"
    fi
else
    echo "qmicli not available"
fi
echo

# 5. ModemManager logs analysis
echo "Recent ModemManager Issues (last 50 lines):"
journalctl -u ModemManager --no-pager -n 50 | grep -E "error|warn|timeout|fail" | tail -10
echo

echo "QMI Protocol Errors:"
journalctl -u ModemManager --no-pager -n 200 | grep -i "qmi" | grep -E "error|timeout|fail" | tail -10
echo

# 6. Modem enumeration performance
echo "Modem Enumeration Performance:"
echo "Starting mmcli modem list test..."
start_time=$(date +%s.%N)
modem_count=$(mmcli -L 2>/dev/null | grep -c "/org/freedesktop/ModemManager1/Modem/" || echo "0")
end_time=$(date +%s.%N)
duration=$(echo "$end_time - $start_time" | bc 2>/dev/null || echo "unknown")
echo "Found $modem_count modems in ${duration}s"

# Test individual modem response time
if [ "$modem_count" -gt 0 ]; then
    echo "Testing individual modem response time:"
    first_modem=$(mmcli -L 2>/dev/null | grep "/org/freedesktop/ModemManager1/Modem/" | head -1 | awk '{print $1}')
    if [ -n "$first_modem" ]; then
        start_time=$(date +%s.%N)
        mmcli -m "$first_modem" --simple-status >/dev/null 2>&1
        end_time=$(date +%s.%N)
        duration=$(echo "$end_time - $start_time" | bc 2>/dev/null || echo "unknown")
        echo "Single modem query took ${duration}s"
    fi
fi
echo

# 7. System resource impact
echo "System Resource Impact:"
echo "USB device count: $(lsusb | wc -l)"
echo "Serial interfaces: $(find /dev -name "ttyUSB*" 2>/dev/null | wc -l)"

# Check for resource exhaustion signs
echo "Resource exhaustion indicators:"
dmesg | grep -E "ModemManager.*memory|ModemManager.*resource|too many.*modem" | tail -5

# 8. ModemManager restart frequency
echo "ModemManager Restart History:"
journalctl -u ModemManager --no-pager | grep -E "Started|Stopped" | tail -10
echo

# 9. Check for ModemManager plugins
echo "ModemManager Plugins:"
if [ -d /usr/lib/ModemManager ]; then
    echo "Available plugins:"
    ls /usr/lib/ModemManager/ 2>/dev/null | grep -E "libmm-plugin.*\.so" | head -10
elif [ -d /usr/lib64/ModemManager ]; then
    ls /usr/lib64/ModemManager/ 2>/dev/null | grep -E "libmm-plugin.*\.so" | head -10
else
    echo "ModemManager plugins directory not found"
fi

# 10. Concurrent operations test
echo "Concurrent Operations Test:"
echo "Testing parallel mmcli operations..."
if [ "$modem_count" -gt 5 ]; then
    echo "Running 5 parallel modem queries..."
    start_time=$(date +%s.%N)
    for i in $(seq 1 5); do
        (mmcli -L >/dev/null 2>&1) &
    done
    wait
    end_time=$(date +%s.%N)
    duration=$(echo "$end_time - $start_time" | bc 2>/dev/null || echo "unknown")
    echo "5 parallel queries completed in ${duration}s"
fi