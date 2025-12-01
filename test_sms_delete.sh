#!/bin/bash
# Test SMS deletion on SIM cards

echo "🔬 SMS Deletion Test Script"
echo "=========================="

# List modems
echo ""
echo "📱 Listing modems..."
modems=$(mmcli -L 2>/dev/null | grep -oP 'Modem/\K[0-9]+')
modem_count=$(echo "$modems" | wc -l)
echo "Found $modem_count modems"

# Get first modem with messages
target_modem=""
for modem in $(echo "$modems" | head -5); do
    echo "Checking modem $modem..."
    messages=$(mmcli -m $modem --messaging-list-sms 2>/dev/null | grep -oP 'SMS/\K[0-9]+' | head -1)
    if [ ! -z "$messages" ]; then
        target_modem=$modem
        echo "✅ Found modem $modem with messages"
        break
    fi
done

if [ -z "$target_modem" ]; then
    echo "❌ No modem with messages found"
    exit 1
fi

echo ""
echo "🎯 Testing deletion on modem: $target_modem"

# List messages
echo ""
echo "📥 Listing messages..."
sms_list=$(mmcli -m $target_modem --messaging-list-sms 2>/dev/null)
echo "$sms_list"

# Get first message path
first_sms=$(echo "$sms_list" | grep -oP '/org/freedesktop/ModemManager1/SMS/[0-9]+' | head -1)
if [ -z "$first_sms" ]; then
    echo "❌ No SMS found"
    exit 1
fi

echo ""
echo "🗑️  Attempting to delete SMS: $first_sms"

# Show SMS details before deletion
echo ""
echo "📧 Message details:"
mmcli -s $first_sms 2>&1

# METHOD 1: Delete using mmcli
echo ""
echo "=== METHOD 1: mmcli --messaging-delete-sms ==="
mmcli -m $target_modem --messaging-delete-sms=$first_sms 2>&1
result1=$?
if [ $result1 -eq 0 ]; then
    echo "✅ SUCCESS with mmcli!"
else
    echo "❌ FAILED with mmcli (exit code: $result1)"
fi

# METHOD 2: Delete using busctl
echo ""
echo "=== METHOD 2: busctl Delete method ==="
busctl call org.freedesktop.ModemManager1 \
    /org/freedesktop/ModemManager1/Modem/$target_modem \
    org.freedesktop.ModemManager1.Modem.Messaging \
    Delete o $first_sms 2>&1
result2=$?
if [ $result2 -eq 0 ]; then
    echo "✅ SUCCESS with busctl!"
else
    echo "❌ FAILED with busctl (exit code: $result2)"
fi

# METHOD 3: Check ModemManager service status
echo ""
echo "=== ModemManager Status ==="
systemctl status ModemManager | head -15

# METHOD 4: Check if message still exists
echo ""
echo "🔍 Checking if message still exists..."
still_exists=$(mmcli -m $target_modem --messaging-list-sms 2>/dev/null | grep -F "$first_sms")
if [ -z "$still_exists" ]; then
    echo "✅ Message successfully deleted!"
else
    echo "❌ Message still exists: $still_exists"
fi

# Check permissions and storage
echo ""
echo "=== Storage Check ==="
echo "SIM storage status:"
mmcli -m $target_modem --messaging-status 2>&1 | grep -i storage

echo ""
echo "📊 Test complete!"