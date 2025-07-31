#!/usr/bin/env bash
# Fix modem 24 with QMI error 54 and ICCID detection issues

echo "🔧 Fixing Modem 24"
echo "=================="

MODEM_ID="24"

# Step 1: Clear SMS storage via AT command
echo "1️⃣ Clearing SMS storage via AT command..."
mmcli -m "$MODEM_ID" --command="AT+CMGD=0,4" 2>/dev/null || echo "   (AT command failed, continuing...)"

# Step 2: Disable the modem
echo "2️⃣ Disabling modem..."
mmcli -m "$MODEM_ID" --disable 2>/dev/null || true
sleep 3

# Step 3: Power cycle
echo "3️⃣ Power cycling modem..."
mmcli -m "$MODEM_ID" --set-power-state=off 2>/dev/null || true
sleep 5
mmcli -m "$MODEM_ID" --set-power-state=on 2>/dev/null || true
sleep 5

# Step 4: Re-enable the modem
echo "4️⃣ Re-enabling modem..."
mmcli -m "$MODEM_ID" --enable 2>/dev/null || true
sleep 5

# Step 5: Reset bearer
echo "5️⃣ Resetting bearer..."
mmcli -m "$MODEM_ID" --reset-bearers 2>/dev/null || true

# Step 6: Check modem status
echo ""
echo "📊 Checking modem status..."
mmcli -m "$MODEM_ID" | grep -E "(state:|signal quality:|operator name:|primary sim path:)"

# Step 7: Check SIM status
echo ""
echo "📊 Checking SIM status..."
mmcli -i "$MODEM_ID" | grep -E "(iccid:|active:|operator id:)"

# Step 8: List any SMS messages
echo ""
echo "📊 Checking SMS storage..."
SMS_COUNT=$(mmcli -m "$MODEM_ID" --messaging-list-sms 2>/dev/null | grep -c SMS || echo "0")
echo "   SMS messages in storage: $SMS_COUNT"

if [ "$SMS_COUNT" -gt "0" ]; then
    echo "   ⚠️  Found SMS messages, attempting to delete..."
    mmcli -m "$MODEM_ID" --messaging-delete-sms=all 2>/dev/null || true
fi

echo ""
echo "✅ Modem 24 reset complete!"
echo ""
echo "🔄 Restarting ModemManager to ensure clean state..."
systemctl restart ModemManager
sleep 5

echo "🔄 Restarting SMS daemon..."
systemctl restart sms-daemon

echo ""
echo "✅ All done! Monitor with: journalctl -fu sms-daemon"