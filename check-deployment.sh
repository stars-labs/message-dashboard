#!/usr/bin/env bash

# Quick deployment check for v5.1.0 with Native D-Bus
# Usage: bash check-deployment.sh

HOST="root@203.116.95.146"

echo "======================================"
echo "SMS Daemon v5.1.0 Deployment Check"
echo "======================================"
echo ""

# Check if we can SSH
if ! ssh -o ConnectTimeout=5 $HOST "echo 'SSH OK'" > /dev/null 2>&1; then
    echo "❌ Cannot connect via SSH to $HOST"
    echo "Please ensure you have SSH access configured"
    echo ""
    echo "To check manually from a machine with SSH access:"
    echo ""
    echo "1. Service Status:"
    echo "   ssh $HOST 'systemctl status sms-daemon'"
    echo ""
    echo "2. Check for Native D-Bus:"
    echo "   ssh $HOST 'journalctl -u sms-daemon -n 50 | grep -E \"Native D-Bus|Using native|busctl\"'"
    echo ""
    echo "3. Performance Metrics:"
    echo "   ssh $HOST 'journalctl -u sms-daemon -n 100 | grep -E \"Performance:|Worker pool stats|ms/modem\"'"
    echo ""
    echo "4. Recent Logs:"
    echo "   ssh $HOST 'journalctl -u sms-daemon -n 50 --no-pager'"
    echo ""
    echo "5. Run Benchmark:"
    echo "   ssh $HOST 'systemctl stop sms-daemon && /nix/store/*/bin/orange-pi-daemon-rust benchmark && systemctl start sms-daemon'"
    echo ""
    exit 1
fi

echo "✅ SSH connection successful"
echo ""

# 1. Service Status
echo "1. Service Status"
echo "-----------------"
ssh $HOST 'systemctl status sms-daemon --no-pager | head -15'
echo ""

# 2. Check version
echo "2. Version Check"
echo "----------------"
ssh $HOST 'journalctl -u sms-daemon -n 200 | grep -E "v5\.[0-9]+\.[0-9]+" | head -1'
echo ""

# 3. Native D-Bus Status
echo "3. D-Bus Method Check"
echo "--------------------"
NATIVE_DBUS=$(ssh $HOST 'journalctl -u sms-daemon -n 200 | grep -E "Native D-Bus client initialized|Using native D-Bus" | head -1')
BUSCTL_FALLBACK=$(ssh $HOST 'journalctl -u sms-daemon -n 200 | grep -E "Using busctl|Falling back" | head -1')

if [[ -n "$NATIVE_DBUS" ]]; then
    echo "✅ Native D-Bus is active!"
    echo "   $NATIVE_DBUS"
elif [[ -n "$BUSCTL_FALLBACK" ]]; then
    echo "⚠️  Using busctl fallback (slower performance)"
    echo "   $BUSCTL_FALLBACK"
else
    echo "❓ Could not determine D-Bus method"
fi
echo ""

# 4. Performance Metrics
echo "4. Performance Metrics"
echo "----------------------"
PERF_METRICS=$(ssh $HOST 'journalctl -u sms-daemon -n 200 | grep "Performance:" | tail -3')
if [[ -n "$PERF_METRICS" ]]; then
    echo "$PERF_METRICS"
else
    echo "No performance metrics found yet (daemon may be starting)"
fi
echo ""

# 5. Worker Pool Stats
echo "5. Worker Pool Statistics"
echo "-------------------------"
WORKER_STATS=$(ssh $HOST 'journalctl -u sms-daemon -n 200 | grep "Worker pool stats" | tail -1')
if [[ -n "$WORKER_STATS" ]]; then
    echo "$WORKER_STATS"
else
    echo "No worker pool stats found yet"
fi
echo ""

# 6. Error Check
echo "6. Recent Errors/Warnings"
echo "-------------------------"
ERRORS=$(ssh $HOST 'journalctl -u sms-daemon -n 100 | grep -E "ERROR|WARN" | tail -5')
if [[ -n "$ERRORS" ]]; then
    echo "$ERRORS"
else
    echo "✅ No recent errors or warnings"
fi
echo ""

# 7. Modem Count
echo "7. Modem Detection"
echo "------------------"
MODEM_COUNT=$(ssh $HOST 'journalctl -u sms-daemon -n 200 | grep -E "Processing [0-9]+ modems" | tail -1')
if [[ -n "$MODEM_COUNT" ]]; then
    echo "$MODEM_COUNT"
else
    echo "Modem count not found in recent logs"
fi
echo ""

# 8. Summary
echo "======================================"
echo "Summary"
echo "======================================"
echo ""
echo "Key Performance Indicators to Look For:"
echo "- Native D-Bus: ~5ms per modem operation"
echo "- Busctl fallback: ~50ms per modem operation"
echo "- For 92 modems: Should complete in <1 second with native D-Bus"
echo ""
echo "To run a performance benchmark:"
echo "ssh $HOST 'systemctl stop sms-daemon && /nix/store/*/bin/orange-pi-daemon-rust benchmark && systemctl start sms-daemon'"
echo ""
echo "To watch live logs:"
echo "ssh $HOST 'journalctl -u sms-daemon -f'"