#!/usr/bin/env bash
# USB Health Monitoring Script for 100 EC25 Modems
# Tracks power, bandwidth, errors, and dropouts in real-time

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Logging setup
LOG_DIR="/var/log/usb-modem-diagnostics"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/usb-health-$(date +%Y%m%d-%H%M%S).log"

# Function to log with timestamp
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Function to check USB power consumption
check_usb_power() {
    log_message "=== USB Power Analysis ==="
    
    local total_current=0
    local device_count=0
    
    for device in /sys/bus/usb/devices/[0-9]*; do
        if [[ -f "$device/idVendor" ]] && grep -q "2c7c" "$device/idVendor" 2>/dev/null; then
            device_count=$((device_count + 1))
            
            # Read current if available
            if [[ -f "$device/power/current_now" ]]; then
                current=$(cat "$device/power/current_now" 2>/dev/null || echo "0")
                total_current=$((total_current + current))
            fi
            
            # Check for power errors
            if [[ -f "$device/power/runtime_status" ]]; then
                status=$(cat "$device/power/runtime_status")
                if [[ "$status" != "active" ]]; then
                    echo -e "${YELLOW}Warning: Device $(basename $device) in $status state${NC}"
                fi
            fi
        fi
    done
    
    log_message "Active EC25 modems: $device_count"
    log_message "Total current draw: $((total_current / 1000))mA"
    
    # Alert if current exceeds safe threshold
    if [[ $((total_current / 1000)) -gt 40000 ]]; then
        echo -e "${RED}CRITICAL: Current draw exceeds 40A!${NC}"
    fi
}

# Function to detect USB errors
check_usb_errors() {
    log_message "=== USB Error Detection ==="
    
    # Check dmesg for USB errors in last hour
    local errors=$(dmesg -T --since "1 hour ago" | grep -iE "usb.*error|disconnect|overcurrent|cannot enumerate" | wc -l)
    
    if [[ $errors -gt 0 ]]; then
        echo -e "${YELLOW}Found $errors USB errors in last hour:${NC}"
        dmesg -T --since "1 hour ago" | grep -iE "usb.*error|disconnect|overcurrent" | tail -10
    fi
    
    # Check for xHCI errors
    local xhci_errors=$(dmesg | grep -c "xhci_hcd.*ERROR" || true)
    if [[ $xhci_errors -gt 0 ]]; then
        echo -e "${RED}xHCI controller errors detected: $xhci_errors${NC}"
    fi
}

# Function to monitor USB bandwidth
check_usb_bandwidth() {
    log_message "=== USB Bandwidth Analysis ==="
    
    # Get USB controller statistics
    for controller in /sys/class/usb_host/usb*; do
        if [[ -d "$controller" ]]; then
            local name=$(basename "$controller")
            
            # Check URB statistics if available
            if [[ -f "/sys/kernel/debug/usb/$name/bandwidth" ]]; then
                local bandwidth=$(cat "/sys/kernel/debug/usb/$name/bandwidth" 2>/dev/null || echo "N/A")
                log_message "Controller $name bandwidth: $bandwidth"
            fi
        fi
    done
    
    # Estimate bandwidth usage from network interfaces
    local total_rx=0
    local total_tx=0
    
    for iface in $(ls /sys/class/net/ | grep -E "wwan|usb"); do
        if [[ -f "/sys/class/net/$iface/statistics/rx_bytes" ]]; then
            rx=$(cat "/sys/class/net/$iface/statistics/rx_bytes")
            tx=$(cat "/sys/class/net/$iface/statistics/tx_bytes")
            total_rx=$((total_rx + rx))
            total_tx=$((total_tx + tx))
        fi
    done
    
    log_message "Total network RX: $((total_rx / 1048576))MB, TX: $((total_tx / 1048576))MB"
}

# Function to check ModemManager status
check_modemmanager() {
    log_message "=== ModemManager Status ==="
    
    local mm_modems=$(mmcli -L 2>/dev/null | grep -c "Modem" || echo "0")
    local usb_modems=$(lsusb | grep -c "EC25" || echo "0")
    
    log_message "USB EC25 devices: $usb_modems"
    log_message "ModemManager sees: $mm_modems"
    
    if [[ $mm_modems -lt $usb_modems ]]; then
        local missing=$((usb_modems - mm_modems))
        echo -e "${YELLOW}WARNING: $missing modems not detected by ModemManager${NC}"
        
        # Check for QMI errors
        local qmi_errors=$(journalctl -u ModemManager --since "1 hour ago" | grep -c "QMI" || true)
        if [[ $qmi_errors -gt 0 ]]; then
            echo -e "${YELLOW}Found $qmi_errors QMI errors in ModemManager logs${NC}"
        fi
    fi
}

# Function to detect EMI/RFI issues
check_emi_interference() {
    log_message "=== EMI/RFI Interference Check ==="
    
    # Check for USB timing errors that indicate EMI
    local timing_errors=$(dmesg | grep -c "USB timing" || true)
    local crc_errors=$(dmesg | grep -c "CRC error" || true)
    
    if [[ $((timing_errors + crc_errors)) -gt 10 ]]; then
        echo -e "${RED}High EMI suspected: $timing_errors timing errors, $crc_errors CRC errors${NC}"
        log_message "Recommendation: Add ferrite cores to USB cables"
    fi
    
    # Check signal strength variance (high variance indicates interference)
    local signals=""
    for i in $(mmcli -L 2>/dev/null | grep -o "/Modem/[0-9]*" | cut -d/ -f3); do
        signal=$(mmcli -m "$i" --signal-get 2>/dev/null | grep "Recent" | grep -o "[0-9]*" | head -1)
        if [[ -n "$signal" ]]; then
            signals="$signals $signal"
        fi
    done
    
    if [[ -n "$signals" ]]; then
        # Calculate variance
        local mean=$(echo "$signals" | awk '{sum=0; for(i=1;i<=NF;i++)sum+=$i; print sum/NF}')
        local variance=$(echo "$signals" | awk -v mean="$mean" '{sum=0; for(i=1;i<=NF;i++)sum+=($i-mean)^2; print sum/NF}')
        
        log_message "Signal variance: $variance (high values indicate interference)"
        
        if (( $(echo "$variance > 200" | bc -l) )); then
            echo -e "${YELLOW}High signal variance detected - possible RF interference${NC}"
        fi
    fi
}

# Function to check thermal status
check_thermal() {
    log_message "=== Thermal Status ==="
    
    # Check CPU temperature
    if [[ -f "/sys/class/thermal/thermal_zone0/temp" ]]; then
        local cpu_temp=$(cat /sys/class/thermal/thermal_zone0/temp)
        cpu_temp=$((cpu_temp / 1000))
        log_message "CPU temperature: ${cpu_temp}°C"
        
        if [[ $cpu_temp -gt 70 ]]; then
            echo -e "${YELLOW}WARNING: High CPU temperature${NC}"
        fi
    fi
    
    # Estimate modem heat generation
    local active_modems=$(mmcli -L 2>/dev/null | grep -c "Modem" || echo "0")
    local heat_watts=$((active_modems * 3))
    log_message "Estimated heat generation: ${heat_watts}W"
    
    if [[ $heat_watts -gt 150 ]]; then
        echo -e "${RED}CRITICAL: Excessive heat generation - cooling required${NC}"
    fi
}

# Main monitoring loop
main() {
    log_message "Starting USB modem health monitoring..."
    log_message "System: $(uname -a)"
    log_message "Date: $(date)"
    
    while true; do
        clear
        echo "==================================================="
        echo "    USB Modem Health Monitor - $(date '+%H:%M:%S')"
        echo "==================================================="
        
        check_usb_power
        echo ""
        
        check_usb_errors
        echo ""
        
        check_usb_bandwidth
        echo ""
        
        check_modemmanager
        echo ""
        
        check_emi_interference
        echo ""
        
        check_thermal
        echo ""
        
        # Summary status
        echo "==================================================="
        local usb_count=$(lsusb | grep -c "EC25" || echo "0")
        local mm_count=$(mmcli -L 2>/dev/null | grep -c "Modem" || echo "0")
        
        if [[ $mm_count -eq $usb_count ]] && [[ $usb_count -gt 90 ]]; then
            echo -e "${GREEN}System Status: HEALTHY${NC}"
        elif [[ $mm_count -gt 50 ]]; then
            echo -e "${YELLOW}System Status: DEGRADED${NC}"
        else
            echo -e "${RED}System Status: CRITICAL${NC}"
        fi
        
        echo "USB Modems: $usb_count | ModemManager: $mm_count"
        echo "Log: $LOG_FILE"
        echo "==================================================="
        echo "Press Ctrl+C to stop monitoring"
        
        sleep 60
    done
}

# Trap to handle cleanup
trap 'log_message "Monitoring stopped"; exit 0' INT TERM

# Run main function
main