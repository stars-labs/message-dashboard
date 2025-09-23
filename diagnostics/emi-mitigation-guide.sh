#!/usr/bin/env bash
# EMI/RFI Mitigation Guide for 100 LTE Modems
# Diagnoses and provides solutions for electromagnetic interference

set -euo pipefail

# Color codes
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# EMI detection and analysis
detect_emi_symptoms() {
    echo -e "${BLUE}=== EMI/RFI Symptom Detection ===${NC}"
    echo ""
    
    local symptoms=0
    
    # Check for CRC errors (strong EMI indicator)
    local crc_errors=$(dmesg | grep -c "CRC" || echo "0")
    if [[ $crc_errors -gt 0 ]]; then
        echo -e "${YELLOW}✗ Found $crc_errors CRC errors - indicates data corruption from EMI${NC}"
        ((symptoms++))
    else
        echo -e "${GREEN}✓ No CRC errors detected${NC}"
    fi
    
    # Check for USB disconnect/reconnect cycles
    local disconnects=$(dmesg -T --since "1 hour ago" | grep -c "USB disconnect" || echo "0")
    if [[ $disconnects -gt 5 ]]; then
        echo -e "${YELLOW}✗ High USB disconnection rate: $disconnects/hour${NC}"
        ((symptoms++))
    else
        echo -e "${GREEN}✓ USB connection stable${NC}"
    fi
    
    # Check for enumeration failures
    local enum_failures=$(dmesg | grep -c "cannot enumerate" || echo "0")
    if [[ $enum_failures -gt 0 ]]; then
        echo -e "${YELLOW}✗ USB enumeration failures: $enum_failures${NC}"
        ((symptoms++))
    else
        echo -e "${GREEN}✓ No enumeration failures${NC}"
    fi
    
    # Check for timing errors
    local timing_errors=$(dmesg | grep -c -E "timing|timeout|babel" || echo "0")
    if [[ $timing_errors -gt 10 ]]; then
        echo -e "${YELLOW}✗ Excessive timing errors: $timing_errors${NC}"
        ((symptoms++))
    else
        echo -e "${GREEN}✓ Timing within normal range${NC}"
    fi
    
    echo ""
    if [[ $symptoms -gt 2 ]]; then
        echo -e "${RED}EMI/RFI interference highly likely ($symptoms/4 symptoms present)${NC}"
        return 1
    elif [[ $symptoms -gt 0 ]]; then
        echo -e "${YELLOW}Possible EMI/RFI interference ($symptoms/4 symptoms present)${NC}"
        return 2
    else
        echo -e "${GREEN}No significant EMI/RFI detected${NC}"
        return 0
    fi
}

# Calculate RF power and interference
calculate_rf_exposure() {
    echo -e "${BLUE}=== RF Power Calculation ===${NC}"
    echo ""
    
    local num_modems=$(lsusb | grep -c "EC25" || echo "0")
    
    # EC25 specifications
    local tx_power_dbm=23  # 23dBm = 200mW
    local tx_power_mw=200
    
    # Calculate combined RF power
    local total_power_mw=$((num_modems * tx_power_mw))
    local total_power_w=$(echo "scale=2; $total_power_mw / 1000" | bc)
    
    echo "RF Power Analysis:"
    echo "├─ Single EC25 TX Power: ${tx_power_dbm}dBm (${tx_power_mw}mW)"
    echo "├─ Number of Modems: $num_modems"
    echo "├─ Combined RF Power: ${total_power_w}W"
    echo ""
    
    # Calculate field strength at different distances
    echo "Near-field Exposure (approximate):"
    for distance in 0.1 0.5 1.0 2.0 5.0; do
        # Simplified near-field calculation (not accurate for complex setup)
        local field_strength=$(echo "scale=2; sqrt($total_power_w * 30) / $distance" | bc)
        echo "├─ At ${distance}m: ${field_strength} V/m"
    done
    echo ""
    
    # Frequency analysis
    echo "LTE Frequency Bands (EC25 supports):"
    echo "├─ B1:  2100 MHz (wavelength: 14.3cm)"
    echo "├─ B3:  1800 MHz (wavelength: 16.7cm)"
    echo "├─ B5:  850 MHz  (wavelength: 35.3cm)"
    echo "├─ B7:  2600 MHz (wavelength: 11.5cm)"
    echo "├─ B8:  900 MHz  (wavelength: 33.3cm)"
    echo "├─ B20: 800 MHz  (wavelength: 37.5cm)"
    echo ""
    
    # USB cable as antenna
    echo -e "${YELLOW}USB Cable Antenna Effect:${NC}"
    echo "Standard USB cable (1-2m) acts as antenna for:"
    echo "├─ Quarter-wave: 750-375 MHz"
    echo "├─ Half-wave: 150-75 MHz"
    echo "└─ Full-wave: 300-150 MHz"
    echo "Result: Significant coupling at LTE frequencies!"
    echo ""
}

# Generate mitigation recommendations
generate_mitigation_plan() {
    echo -e "${BLUE}=== EMI/RFI Mitigation Plan ===${NC}"
    echo ""
    
    echo -e "${CYAN}Priority 1: Immediate Actions (Today)${NC}"
    echo "□ Install ferrite cores on ALL USB cables"
    echo "  └─ Part: Fair-Rite 0431164181 (31 material, 13mm ID)"
    echo "  └─ Installation: 2-3 turns through core near modem end"
    echo ""
    echo "□ Separate modems spatially"
    echo "  └─ Minimum 10cm between modems"
    echo "  └─ Avoid parallel cable runs"
    echo "  └─ Use cable management for perpendicular crossings"
    echo ""
    echo "□ Ground all metal components"
    echo "  └─ USB hub chassis to common ground"
    echo "  └─ Use star grounding topology"
    echo "  └─ 8 AWG or thicker ground wire"
    echo ""
    
    echo -e "${CYAN}Priority 2: Cable Improvements (This Week)${NC}"
    echo "□ Replace USB cables with shielded versions"
    echo "  └─ Double-shielded USB 2.0 cables"
    echo "  └─ Ferrite core at BOTH ends"
    echo "  └─ Keep cables as short as possible (<1m preferred)"
    echo ""
    echo "□ Add common mode chokes"
    echo "  └─ Part: Würth 744232090 (USB 2.0 compatible)"
    echo "  └─ Install inline with USB data lines"
    echo ""
    echo "□ Implement twisted pair for power"
    echo "  └─ Separate power from data where possible"
    echo "  └─ Use twisted pair for DC power distribution"
    echo ""
    
    echo -e "${CYAN}Priority 3: Shielding (This Month)${NC}"
    echo "□ Build Faraday cage sections"
    echo "  └─ Aluminum mesh (1-2mm aperture)"
    echo "  └─ Group 10-20 modems per cage"
    echo "  └─ Ensure adequate ventilation"
    echo ""
    echo "□ Install RF absorbing material"
    echo "  └─ Laird Eccosorb LS series"
    echo "  └─ Line enclosure walls"
    echo "  └─ Focus on 800-2600 MHz range"
    echo ""
    echo "□ Add RF filters"
    echo "  └─ USB data line filters"
    echo "  └─ Power line filters (EMI/RFI suppression)"
    echo ""
    
    echo -e "${CYAN}Priority 4: Frequency Management${NC}"
    echo "□ Configure band separation"
    echo "  └─ Group 1: B20/B8 (800-900 MHz)"
    echo "  └─ Group 2: B3/B7 (1800-2600 MHz)"
    echo "  └─ Physical separation between groups"
    echo ""
    echo "□ Implement time-division multiplexing"
    echo "  └─ Stagger transmission windows"
    echo "  └─ Reduce simultaneous TX operations"
    echo ""
}

# Monitoring script generator
create_emi_monitor() {
    echo -e "${BLUE}=== Creating EMI Monitoring Script ===${NC}"
    
    cat > /tmp/emi-monitor.sh << 'EOF'
#!/bin/bash
# Real-time EMI monitoring
LOG_FILE="/var/log/emi-monitor.log"

while true; do
    echo "[$(date)] EMI Check" >> $LOG_FILE
    
    # Count errors in last minute
    CRC=$(dmesg -T --since "1 minute ago" | grep -c "CRC" || echo 0)
    DISCONNECT=$(dmesg -T --since "1 minute ago" | grep -c "disconnect" || echo 0)
    TIMEOUT=$(dmesg -T --since "1 minute ago" | grep -c "timeout" || echo 0)
    
    # Alert if threshold exceeded
    if [[ $((CRC + DISCONNECT + TIMEOUT)) -gt 5 ]]; then
        echo "EMI ALERT: CRC=$CRC, Disconnect=$DISCONNECT, Timeout=$TIMEOUT" | wall
    fi
    
    echo "CRC=$CRC, Disconnect=$DISCONNECT, Timeout=$TIMEOUT" >> $LOG_FILE
    sleep 60
done
EOF
    
    chmod +x /tmp/emi-monitor.sh
    echo "EMI monitor created at: /tmp/emi-monitor.sh"
    echo "Run with: sudo /tmp/emi-monitor.sh &"
}

# Shopping list generator
generate_shopping_list() {
    local num_modems=$1
    
    echo ""
    echo -e "${BLUE}=== EMI Mitigation Shopping List ($num_modems modems) ===${NC}"
    echo ""
    
    echo "Ferrite Cores:"
    echo "├─ Quantity: $((num_modems * 2)) pieces"
    echo "├─ Fair-Rite 0431164181 - \$2 each"
    echo "└─ Total: \$$(( num_modems * 2 * 2 ))"
    echo ""
    
    echo "Shielded USB Cables:"
    echo "├─ Quantity: $num_modems pieces"
    echo "├─ 1m double-shielded USB 2.0 - \$8 each"
    echo "└─ Total: \$$(( num_modems * 8 ))"
    echo ""
    
    echo "RF Shielding:"
    echo "├─ Aluminum mesh: 10 sq meters - \$200"
    echo "├─ RF absorber sheets: 5 sq meters - \$500"
    echo "├─ Copper tape: 10 rolls - \$100"
    echo "└─ Total: \$800"
    echo ""
    
    echo "Grounding Equipment:"
    echo "├─ Ground rod: 8ft copper - \$30"
    echo "├─ Ground wire: 50ft 8AWG - \$50"
    echo "├─ Ground clamps: 20 pieces - \$40"
    echo "└─ Total: \$120"
    echo ""
    
    local total=$(( num_modems * 10 + 920 ))
    echo -e "${GREEN}Total EMI Mitigation Cost: \$$total${NC}"
}

# Main execution
main() {
    echo "╔════════════════════════════════════════════════╗"
    echo "║     EMI/RFI Mitigation Guide for LTE Modems    ║"
    echo "╚════════════════════════════════════════════════╝"
    echo ""
    
    # Detect symptoms
    detect_emi_symptoms
    local emi_status=$?
    
    echo ""
    
    # Calculate RF exposure
    calculate_rf_exposure
    
    # Generate mitigation plan
    generate_mitigation_plan
    
    echo ""
    
    # Generate shopping list
    local num_modems=$(lsusb | grep -c "EC25" || echo "100")
    generate_shopping_list "$num_modems"
    
    echo ""
    
    # Create monitoring script
    create_emi_monitor
    
    echo ""
    echo -e "${RED}=== Critical Safety Note ===${NC}"
    echo "With 100 LTE modems transmitting simultaneously:"
    echo "├─ Combined RF power: ~20W"
    echo "├─ Maintain 2m minimum distance during operation"
    echo "├─ Consider RF exposure limits for operators"
    echo "└─ May interfere with nearby electronic devices"
    echo ""
    
    if [[ $emi_status -ne 0 ]]; then
        echo -e "${YELLOW}⚠ EMI mitigation is urgently needed for stable operation${NC}"
        echo "Start with Priority 1 actions immediately!"
    fi
}

# Run main
main