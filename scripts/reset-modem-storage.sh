#!/bin/bash
# Emergency script to reset modem storage when overflow occurs

echo "🔧 Modem Storage Reset Tool"
echo "=========================="

# Function to reset a specific modem
reset_modem() {
    local modem_id=$1
    echo "📱 Resetting modem $modem_id..."
    
    # First try to delete all SMS messages
    echo "  - Attempting to clear SMS storage..."
    mmcli -m "$modem_id" --messaging-delete-sms=all 2>/dev/null || true
    
    # Reset the modem
    echo "  - Resetting modem..."
    mmcli -m "$modem_id" --reset 2>/dev/null || {
        echo "  ⚠️  Soft reset failed, trying power cycle..."
        mmcli -m "$modem_id" --set-power-state=off 2>/dev/null || true
        sleep 2
        mmcli -m "$modem_id" --set-power-state=on 2>/dev/null || true
    }
    
    # Wait for modem to come back
    echo "  - Waiting for modem to restart..."
    sleep 10
    
    # Re-enable modem
    echo "  - Re-enabling modem..."
    mmcli -m "$modem_id" --enable 2>/dev/null || true
    
    echo "  ✅ Modem $modem_id reset complete"
}

# Check if specific modem IDs provided
if [ $# -gt 0 ]; then
    # Reset specific modems
    for modem_id in "$@"; do
        reset_modem "$modem_id"
    done
else
    # Find all modems with high SMS IDs or storage issues
    echo "🔍 Detecting problematic modems..."
    
    # Get all modems
    modems=$(mmcli -L 2>/dev/null | grep -oP '/Modem/\K\d+' || true)
    
    for modem_id in $modems; do
        # Check if modem has any SMS
        sms_count=$(mmcli -m "$modem_id" --messaging-list-sms 2>/dev/null | grep -c SMS || echo "0")
        
        # If no SMS visible but we know there are storage issues, reset it
        if [ "$sms_count" -eq "0" ]; then
            # Check if this modem has been failing recently
            recent_errors=$(journalctl -u sms-daemon --since "10 minutes ago" 2>/dev/null | grep -c "modem $modem_id.*WmsCauseCode" || echo "0")
            
            if [ "$recent_errors" -gt "0" ]; then
                echo "⚠️  Modem $modem_id has storage errors but no visible SMS - needs reset"
                reset_modem "$modem_id"
            fi
        fi
    done
fi

echo ""
echo "🏁 Reset complete. Restarting SMS daemon..."
systemctl restart sms-daemon

echo "✅ Done! Monitor the logs with: journalctl -fu sms-daemon"