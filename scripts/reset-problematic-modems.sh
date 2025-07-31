#!/usr/bin/env bash
# Reset all problematic modems and clear their state

echo "🔧 Resetting All Problematic Modems"
echo "===================================="
echo ""

# Find modems with recent QMI errors or issues
echo "🔍 Finding problematic modems..."
PROBLEM_MODEMS=$(journalctl -u sms-daemon --since "1 hour ago" 2>/dev/null | \
    grep -E "(QMI error 54|marked as problematic|corrupted state)" | \
    grep -oE "modem [0-9]+" | \
    awk '{print $2}' | \
    sort -u)

if [ -z "$PROBLEM_MODEMS" ]; then
    echo "✅ No problematic modems found in recent logs"
else
    echo "Found problematic modems: $PROBLEM_MODEMS"
    echo ""
    
    for modem_id in $PROBLEM_MODEMS; do
        echo "🔧 Resetting modem $modem_id..."
        
        # Clear SMS storage
        echo "  - Clearing SMS storage..."
        mmcli -m "$modem_id" --command="AT+CMGD=0,4" 2>/dev/null || true
        
        # Disable/enable cycle
        echo "  - Disabling modem..."
        mmcli -m "$modem_id" --disable 2>/dev/null || true
        sleep 2
        
        echo "  - Re-enabling modem..."
        mmcli -m "$modem_id" --enable 2>/dev/null || true
        sleep 3
        
        # Check status
        STATE=$(mmcli -m "$modem_id" 2>/dev/null | grep "state:" | awk -F': ' '{print $2}' || echo "unknown")
        echo "  ✅ Modem $modem_id state: $STATE"
        echo ""
    done
fi

# Restart services to clear internal problematic modem tracking
echo "🔄 Restarting services to clear problematic modem cache..."
systemctl restart ModemManager
sleep 5
systemctl restart sms-daemon

echo ""
echo "✅ Reset complete!"
echo ""
echo "Monitor daemon logs with: journalctl -fu sms-daemon"
echo ""
echo "If modem 24 still has issues, try physical power cycle:"
echo "  1. Unplug the USB modem"
echo "  2. Wait 10 seconds"
echo "  3. Plug it back in"
echo "  4. Wait for ModemManager to detect it"
echo "  5. Run: systemctl restart sms-daemon"