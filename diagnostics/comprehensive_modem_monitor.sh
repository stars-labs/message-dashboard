#!/bin/bash

# Comprehensive USB Modem Array Monitoring System
# Monitors all aspects: power, thermal, USB, kernel, ModemManager, EMI/RFI
# Run periodically to track system health and identify failure patterns

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/modem-monitoring"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
REPORT_FILE="$LOG_DIR/modem_health_$TIMESTAMP.log"

# Create log directory if it doesn't exist
mkdir -p "$LOG_DIR"

# Ensure all diagnostic scripts are executable
chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null

echo "=== Comprehensive USB Modem Array Health Check ===" | tee "$REPORT_FILE"
echo "Timestamp: $(date)" | tee -a "$REPORT_FILE"
echo "System: $(uname -a)" | tee -a "$REPORT_FILE"
echo "Uptime: $(uptime)" | tee -a "$REPORT_FILE"
echo | tee -a "$REPORT_FILE"

# 1. Quick System Overview
echo "=== SYSTEM OVERVIEW ===" | tee -a "$REPORT_FILE"
echo "Current Quectel modem count: $(lsusb | grep -c '2c7c')" | tee -a "$REPORT_FILE"
echo "Total USB devices: $(lsusb | wc -l)" | tee -a "$REPORT_FILE"
echo "ModemManager status: $(systemctl is-active ModemManager 2>/dev/null || echo 'not managed by systemd')" | tee -a "$REPORT_FILE"
echo "SMS daemon status: $(systemctl is-active sms-daemon 2>/dev/null || echo 'not managed by systemd')" | tee -a "$REPORT_FILE"
echo | tee -a "$REPORT_FILE"

# 2. Critical Health Indicators
echo "=== CRITICAL HEALTH INDICATORS ===" | tee -a "$REPORT_FILE"

# CPU temperature
if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
    cpu_temp=$(cat /sys/class/thermal/thermal_zone0/temp)
    cpu_temp_c=$((cpu_temp / 1000))
    echo "CPU Temperature: ${cpu_temp_c}°C" | tee -a "$REPORT_FILE"
    if [ "$cpu_temp_c" -gt 80 ]; then
        echo "WARNING: High CPU temperature!" | tee -a "$REPORT_FILE"
    fi
fi

# Memory usage
mem_info=$(free -h | grep "Mem:")
echo "Memory: $mem_info" | tee -a "$REPORT_FILE"

# Load average
load_avg=$(uptime | awk -F'load average:' '{print $2}')
echo "Load average:$load_avg" | tee -a "$REPORT_FILE"

# USB errors in last hour
usb_errors=$(dmesg | grep -c "usb.*error" 2>/dev/null || echo "0")
echo "USB errors (dmesg): $usb_errors" | tee -a "$REPORT_FILE"

echo | tee -a "$REPORT_FILE"

# 3. Run detailed diagnostics
echo "=== DETAILED DIAGNOSTIC RESULTS ===" | tee -a "$REPORT_FILE"

# Power analysis
if [ -f "$SCRIPT_DIR/power_analysis.sh" ]; then
    echo "--- Power Analysis ---" | tee -a "$REPORT_FILE"
    bash "$SCRIPT_DIR/power_analysis.sh" 2>&1 | tee -a "$REPORT_FILE"
    echo | tee -a "$REPORT_FILE"
fi

# Thermal analysis
if [ -f "$SCRIPT_DIR/thermal_analysis.sh" ]; then
    echo "--- Thermal Analysis ---" | tee -a "$REPORT_FILE"
    bash "$SCRIPT_DIR/thermal_analysis.sh" 2>&1 | tee -a "$REPORT_FILE"
    echo | tee -a "$REPORT_FILE"
fi

# USB bandwidth analysis
if [ -f "$SCRIPT_DIR/usb_bandwidth_analysis.sh" ]; then
    echo "--- USB Bandwidth Analysis ---" | tee -a "$REPORT_FILE"
    bash "$SCRIPT_DIR/usb_bandwidth_analysis.sh" 2>&1 | tee -a "$REPORT_FILE"
    echo | tee -a "$REPORT_FILE"
fi

# Kernel USB limits
if [ -f "$SCRIPT_DIR/kernel_usb_limits.sh" ]; then
    echo "--- Kernel USB Limits ---" | tee -a "$REPORT_FILE"
    bash "$SCRIPT_DIR/kernel_usb_limits.sh" 2>&1 | tee -a "$REPORT_FILE"
    echo | tee -a "$REPORT_FILE"
fi

# ModemManager analysis
if [ -f "$SCRIPT_DIR/modemmanager_analysis.sh" ]; then
    echo "--- ModemManager Analysis ---" | tee -a "$REPORT_FILE"
    bash "$SCRIPT_DIR/modemmanager_analysis.sh" 2>&1 | tee -a "$REPORT_FILE"
    echo | tee -a "$REPORT_FILE"
fi

# EMI/RFI analysis
if [ -f "$SCRIPT_DIR/emi_rfi_analysis.sh" ]; then
    echo "--- EMI/RFI Analysis ---" | tee -a "$REPORT_FILE"
    bash "$SCRIPT_DIR/emi_rfi_analysis.sh" 2>&1 | tee -a "$REPORT_FILE"
    echo | tee -a "$REPORT_FILE"
fi

# 4. Generate summary and recommendations
echo "=== SUMMARY AND RECOMMENDATIONS ===" | tee -a "$REPORT_FILE"

# Analyze patterns and generate recommendations
current_modems=$(lsusb | grep -c '2c7c' || echo "0")
target_modems=100

if [ "$current_modems" -lt 80 ]; then
    echo "CRITICAL: Significant modem loss detected ($current_modems/$target_modems active)" | tee -a "$REPORT_FILE"
    echo "Recommended actions:" | tee -a "$REPORT_FILE"
    echo "1. Check power supply stability" | tee -a "$REPORT_FILE"
    echo "2. Verify thermal management" | tee -a "$REPORT_FILE"
    echo "3. Examine USB hub health" | tee -a "$REPORT_FILE"
elif [ "$current_modems" -lt 95 ]; then
    echo "WARNING: Moderate modem loss detected ($current_modems/$target_modems active)" | tee -a "$REPORT_FILE"
    echo "Recommended actions:" | tee -a "$REPORT_FILE"
    echo "1. Monitor trending patterns" | tee -a "$REPORT_FILE"
    echo "2. Check for environmental factors" | tee -a "$REPORT_FILE"
else
    echo "OK: Modem count within acceptable range ($current_modems/$target_modems active)" | tee -a "$REPORT_FILE"
fi

# Check temperature
if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
    cpu_temp=$(cat /sys/class/thermal/thermal_zone0/temp)
    cpu_temp_c=$((cpu_temp / 1000))
    if [ "$cpu_temp_c" -gt 75 ]; then
        echo "THERMAL WARNING: Implement additional cooling" | tee -a "$REPORT_FILE"
    fi
fi

# Check USB errors
if [ "$usb_errors" -gt 50 ]; then
    echo "USB WARNING: High error rate, check cable integrity and EMI" | tee -a "$REPORT_FILE"
fi

echo | tee -a "$REPORT_FILE"

# 5. Historical trending
echo "=== HISTORICAL TRENDING ===" | tee -a "$REPORT_FILE"

# Create simple trending data
trend_file="$LOG_DIR/modem_count_trend.csv"
if [ ! -f "$trend_file" ]; then
    echo "timestamp,modem_count,cpu_temp,usb_errors" > "$trend_file"
fi

# Append current data
echo "$TIMESTAMP,$current_modems,${cpu_temp_c:-0},$usb_errors" >> "$trend_file"

# Show recent trend (last 10 entries)
echo "Recent modem count trend:" | tee -a "$REPORT_FILE"
tail -10 "$trend_file" | tee -a "$REPORT_FILE"

echo | tee -a "$REPORT_FILE"

# 6. Generate alerts for automation
alert_file="$LOG_DIR/current_alerts.txt"
> "$alert_file"  # Clear previous alerts

if [ "$current_modems" -lt 80 ]; then
    echo "CRITICAL_MODEM_LOSS:$current_modems" >> "$alert_file"
fi

if [ "${cpu_temp_c:-0}" -gt 75 ]; then
    echo "HIGH_TEMPERATURE:${cpu_temp_c}" >> "$alert_file"
fi

if [ "$usb_errors" -gt 50 ]; then
    echo "HIGH_USB_ERRORS:$usb_errors" >> "$alert_file"
fi

# 7. Cleanup old logs (keep last 30 days)
find "$LOG_DIR" -name "modem_health_*.log" -mtime +30 -delete 2>/dev/null

echo "=== MONITORING COMPLETE ===" | tee -a "$REPORT_FILE"
echo "Full report saved to: $REPORT_FILE" | tee -a "$REPORT_FILE"
echo "Alerts file: $alert_file" | tee -a "$REPORT_FILE"
echo | tee -a "$REPORT_FILE"

# 8. Optional: Send alerts (if configured)
if [ -f "/etc/modem-monitoring/alert-config.sh" ]; then
    source "/etc/modem-monitoring/alert-config.sh"
    if [ -s "$alert_file" ]; then
        echo "Sending alerts..." | tee -a "$REPORT_FILE"
        # Alert mechanism would be implemented here
        # Examples: email, Slack webhook, SMS, etc.
    fi
fi

# 9. Performance optimization suggestions
echo "=== PERFORMANCE OPTIMIZATION SUGGESTIONS ===" | tee -a "$REPORT_FILE"

# Check current kernel parameters
usbfs_mem=$(cat /sys/module/usbcore/parameters/usbfs_memory_mb 2>/dev/null || echo "unknown")
echo "Current usbfs_memory_mb: $usbfs_mem" | tee -a "$REPORT_FILE"

if [ "$usbfs_mem" != "unknown" ] && [ "$usbfs_mem" -lt 512 ]; then
    echo "RECOMMENDATION: Increase usbfs_memory_mb to 512 or higher" | tee -a "$REPORT_FILE"
fi

# Check file descriptor limits
max_fds=$(ulimit -n)
echo "Current FD limit: $max_fds" | tee -a "$REPORT_FILE"

if [ "$max_fds" -lt 4096 ]; then
    echo "RECOMMENDATION: Increase file descriptor limit to 4096+" | tee -a "$REPORT_FILE"
fi

echo "Monitoring script completed successfully."