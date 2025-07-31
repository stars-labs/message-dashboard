#!/bin/bash
# Fix modems stuck with QMI error 54 (phantom storage full)

echo "🔧 Modem QMI Error 54 Fix Tool"
echo "============================="
echo ""
echo "This fixes modems reporting 'storage full' when actually empty"
echo ""

# Function to reset a modem completely
reset_modem_hard() {
    local modem_id=$1
    echo "🔄 Hard resetting modem $modem_id..."
    
    # First, try to clear SMS storage via AT command
    echo "  - Sending AT command to clear all SMS..."
    mmcli -m "$modem_id" --command="AT+CMGD=0,4" 2>/dev/null || echo "    (AT command failed, continuing...)"
    
    # Disable the modem
    echo "  - Disabling modem..."
    mmcli -m "$modem_id" --disable 2>/dev/null || true
    sleep 2
    
    # Power cycle if possible
    echo "  - Power cycling modem..."
    mmcli -m "$modem_id" --set-power-state=off 2>/dev/null || true
    sleep 5
    mmcli -m "$modem_id" --set-power-state=on 2>/dev/null || true
    sleep 5
    
    # Re-enable the modem
    echo "  - Re-enabling modem..."
    mmcli -m "$modem_id" --enable 2>/dev/null || true
    sleep 3
    
    # Reset bearer to clear any network issues
    echo "  - Resetting bearer..."
    mmcli -m "$modem_id" --reset-bearers 2>/dev/null || true
    
    echo "  ✅ Modem $modem_id reset complete"
}

# Check for specific modem or find all problematic ones
if [ $# -gt 0 ]; then
    # Reset specific modems
    for modem_id in "$@"; do
        reset_modem_hard "$modem_id"
    done
else
    echo "🔍 Finding modems with QMI error 54..."
    
    # Look for modems that had recent QMI errors
    problem_modems=$(journalctl -u sms-daemon --since "30 minutes ago" 2>/dev/null | \
        grep -E "modem [0-9]+.*QMI protocol error \(54\)" | \
        grep -oE "modem [0-9]+" | \
        awk '{print $2}' | \
        sort -u)
    
    if [ -z "$problem_modems" ]; then
        echo "✅ No modems with recent QMI error 54 found"
        exit 0
    fi
    
    echo "Found problematic modems: $problem_modems"
    echo ""
    
    for modem_id in $problem_modems; do
        # Check if modem has any visible SMS
        sms_count=$(mmcli -m "$modem_id" --messaging-list-sms 2>/dev/null | grep -c SMS || echo "0")
        
        if [ "$sms_count" -eq "0" ]; then
            echo "⚠️  Modem $modem_id has QMI error 54 but no SMS - needs reset"
            reset_modem_hard "$modem_id"
        else
            echo "ℹ️  Modem $modem_id has $sms_count SMS messages - skipping"
        fi
    done
fi

echo ""
echo "🔄 Restarting ModemManager to ensure clean state..."
systemctl restart ModemManager
sleep 5

echo "🔄 Restarting SMS daemon..."
systemctl restart sms-daemon

echo ""
echo "✅ Fix complete! Monitor with: journalctl -fu sms-daemon"
echo ""
echo "If errors persist, the modem may need:"
echo "  1. Firmware update"
echo "  2. Physical power cycle (unplug/replug USB)"
echo "  3. SIM card removal and reinsertion"