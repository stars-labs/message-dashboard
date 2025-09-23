#!/usr/bin/env bash
# Power Budget Calculator for 100 EC25 Modems
# Calculates required power infrastructure and identifies deficits

set -euo pipefail

# EC25 Power Specifications
EC25_IDLE_CURRENT=0.05  # 50mA idle
EC25_TYPICAL_CURRENT=0.5  # 500mA typical operation
EC25_PEAK_CURRENT=2.0  # 2A during LTE transmission
EC25_VOLTAGE=5.0  # 5V USB power

# Color codes
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

calculate_power_requirements() {
    local num_modems=$1
    
    echo -e "${BLUE}=== Power Budget Analysis for $num_modems EC25 Modems ===${NC}"
    echo ""
    
    # Calculate current requirements
    local idle_total=$(echo "$num_modems * $EC25_IDLE_CURRENT" | bc)
    local typical_total=$(echo "$num_modems * $EC25_TYPICAL_CURRENT" | bc)
    local peak_total=$(echo "$num_modems * $EC25_PEAK_CURRENT" | bc)
    
    # Calculate power in watts
    local idle_watts=$(echo "$idle_total * $EC25_VOLTAGE" | bc)
    local typical_watts=$(echo "$typical_total * $EC25_VOLTAGE" | bc)
    local peak_watts=$(echo "$peak_total * $EC25_VOLTAGE" | bc)
    
    echo "Current Requirements:"
    echo "├─ Idle State: ${idle_total}A (${idle_watts}W)"
    echo "├─ Typical Operation: ${typical_total}A (${typical_watts}W)"
    echo "└─ Peak Load: ${peak_total}A (${peak_watts}W)"
    echo ""
    
    # Calculate hub requirements (assuming 10 modems per hub)
    local hubs_needed=$(( (num_modems + 9) / 10 ))
    local current_per_hub=$(echo "$peak_total / $hubs_needed" | bc)
    
    echo "USB Hub Infrastructure:"
    echo "├─ Hubs Required: $hubs_needed (10 modems each)"
    echo "├─ Current per Hub: ${current_per_hub}A peak"
    echo "└─ Power Supply per Hub: $(echo "$current_per_hub * 1.2" | bc)A recommended (20% margin)"
    echo ""
    
    # Check against typical USB limitations
    echo -e "${YELLOW}USB Standard Limitations:${NC}"
    echo "├─ USB 2.0 Port: 0.5A max (can power 0 modems at peak)"
    echo "├─ USB 3.0 Port: 0.9A max (can power 0 modems at peak)"
    echo "├─ Powered Hub (typical): 4A max (can power 2 modems at peak)"
    echo "└─ Powered Hub (industrial): 10A max (can power 5 modems at peak)"
    echo ""
    
    # Power supply recommendations
    echo -e "${GREEN}Recommended Power Infrastructure:${NC}"
    echo ""
    echo "Option 1: Distributed Power (Recommended)"
    echo "├─ $hubs_needed× Industrial USB Hubs with 20A power supplies"
    echo "├─ Total PSU Capacity: $(echo "$hubs_needed * 20" | bc)A @ 5V"
    echo "├─ Use 12V→5V DC-DC converters rated for 20A continuous"
    echo "└─ Cost estimate: \$$(echo "$hubs_needed * 150" | bc) USD"
    echo ""
    
    echo "Option 2: Centralized Power Distribution"
    echo "├─ 1× Industrial 5V PSU rated for $(echo "$peak_total * 1.2" | bc)A"
    echo "├─ Custom power distribution PCB with overcurrent protection"
    echo "├─ Individual 3A polyfuses per modem"
    echo "└─ Cost estimate: \$800-1200 USD"
    echo ""
    
    echo "Option 3: ATX PSU Array"
    echo "├─ $(echo "$peak_watts / 150" | bc -l | cut -d. -f1)× ATX PSUs (150W @ 5V rail each)"
    echo "├─ Custom wiring harness with terminal blocks"
    echo "├─ Add capacitor banks (10,000µF per 10 modems)"
    echo "└─ Cost estimate: \$$(echo "($peak_watts / 150) * 50" | bc) USD"
    echo ""
    
    # Warning calculations
    echo -e "${RED}Critical Warnings:${NC}"
    
    # Voltage drop calculation
    local cable_resistance=0.05  # 50mΩ for 1m USB cable
    local voltage_drop=$(echo "$peak_total * $cable_resistance" | bc)
    
    if (( $(echo "$voltage_drop > 0.5" | bc -l) )); then
        echo "├─ Voltage drop at peak load: ${voltage_drop}V"
        echo "├─ USB devices may brownout below 4.5V"
        echo "├─ Solution: Use thicker cables (AWG 20 or better)"
    fi
    
    # Inrush current warning
    local inrush_current=$(echo "$num_modems * 3" | bc)  # 3A inrush per modem
    echo "├─ Inrush current at startup: ${inrush_current}A"
    echo "├─ Implement staged power-on (10 modems per second)"
    echo ""
    
    # Heat dissipation
    echo -e "${YELLOW}Thermal Considerations:${NC}"
    echo "├─ Heat generation at typical load: ${typical_watts}W"
    echo "├─ Heat generation at peak load: ${peak_watts}W"
    echo "├─ Required airflow: $(echo "$peak_watts * 3" | bc) CFM"
    echo "└─ Recommended: Active cooling with temperature monitoring"
}

# Function to analyze actual vs required
analyze_current_setup() {
    echo ""
    echo -e "${BLUE}=== Current System Analysis ===${NC}"
    echo ""
    
    # Count actual modems
    local usb_modems=$(lsusb | grep -c "EC25" || echo "0")
    local active_modems=$(mmcli -L 2>/dev/null | grep -c "Modem" || echo "0")
    
    echo "Detected Configuration:"
    echo "├─ USB EC25 devices: $usb_modems"
    echo "├─ Active in ModemManager: $active_modems"
    echo "└─ Inactive/Failed: $((usb_modems - active_modems))"
    echo ""
    
    # Estimate current power deficit
    local required_current=$(echo "$usb_modems * $EC25_TYPICAL_CURRENT" | bc)
    local typical_hub_capacity=$(echo "$usb_modems / 10 * 4" | bc)  # Assuming 4A hubs
    local power_deficit=$(echo "$required_current - $typical_hub_capacity" | bc)
    
    if (( $(echo "$power_deficit > 0" | bc -l) )); then
        echo -e "${RED}Power Deficit Detected:${NC}"
        echo "├─ Required: ${required_current}A"
        echo "├─ Estimated Available: ${typical_hub_capacity}A"
        echo "├─ Deficit: ${power_deficit}A"
        echo "└─ This explains $(echo "$power_deficit / $EC25_TYPICAL_CURRENT" | bc) modems dropping offline"
    else
        echo -e "${GREEN}Power supply appears adequate${NC}"
    fi
}

# Function to generate procurement list
generate_procurement_list() {
    local num_modems=$1
    
    echo ""
    echo -e "${BLUE}=== Procurement List for $num_modems Modems ===${NC}"
    echo ""
    
    local hubs_needed=$(( (num_modems + 9) / 10 ))
    
    echo "Essential Components:"
    echo "1. Power Supplies"
    echo "   ├─ $hubs_needed× Mean Well LRS-100-5 (5V 20A PSU) - \$30 each"
    echo "   └─ Alternative: $((hubs_needed / 2))× Mean Well LRS-200-5 (5V 40A PSU) - \$45 each"
    echo ""
    
    echo "2. USB Hubs"
    echo "   ├─ $hubs_needed× Industrial 10-port USB 2.0 Hub - \$50 each"
    echo "   └─ Must support external power input"
    echo ""
    
    echo "3. Power Distribution"
    echo "   ├─ $hubs_needed× DC barrel jack splitters (5.5×2.1mm)"
    echo "   ├─ 100× USB power injection cables"
    echo "   └─ $((num_modems / 10))× Terminal block (30A rated)"
    echo ""
    
    echo "4. Protection Devices"
    echo "   ├─ $num_modems× 3A resettable fuses (polyfuse)"
    echo "   ├─ $hubs_needed× 25A circuit breakers"
    echo "   └─ 10× 4700µF capacitors (surge suppression)"
    echo ""
    
    echo "5. Cooling"
    echo "   ├─ 4× 120mm fans (100+ CFM each)"
    echo "   ├─ Temperature monitoring system"
    echo "   └─ Thermal pads/heatsinks for modems"
    echo ""
    
    echo "6. EMI Mitigation"
    echo "   ├─ 100× Ferrite cores (USB cables)"
    echo "   ├─ RF shielding mesh/enclosure"
    echo "   └─ Grounding straps and terminals"
    echo ""
    
    local total_cost=$((hubs_needed * 30 + hubs_needed * 50 + num_modems * 2 + 200))
    echo -e "${GREEN}Estimated Total Cost: \$$total_cost USD${NC}"
}

# Main execution
main() {
    echo "╔════════════════════════════════════════════════╗"
    echo "║   USB Modem Power Infrastructure Calculator    ║"
    echo "╚════════════════════════════════════════════════╝"
    echo ""
    
    # Default to 100 modems if not specified
    local num_modems=${1:-100}
    
    calculate_power_requirements "$num_modems"
    analyze_current_setup
    generate_procurement_list "$num_modems"
    
    echo ""
    echo -e "${BLUE}=== Quick Fixes to Try First ===${NC}"
    echo "1. Power cycle all USB hubs"
    echo "2. Connect hubs to different power circuits"
    echo "3. Add powered USB Y-cables for high-drain modems"
    echo "4. Reduce modem count to match power budget"
    echo "5. Implement staged power-on sequence"
    echo ""
    
    echo -e "${YELLOW}Run 'sudo ./usb-health-monitor.sh' for real-time monitoring${NC}"
}

# Run with optional modem count argument
main "$@"