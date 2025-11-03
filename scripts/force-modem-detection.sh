#!/bin/bash

# Force ModemManager to detect multiple modems by scanning in smaller batches
# This works around ModemManager's internal limits when dealing with 87+ modems

echo "=========================================="
echo "Force Modem Detection Script"
echo "=========================================="
echo ""

# Stop ModemManager to reset state
echo "Stopping ModemManager..."
systemctl stop ModemManager
sleep 2

# Start ModemManager with reduced probe parallelism
echo "Starting ModemManager with reduced parallelism..."
MM_MAX_PARALLEL_PROBES=5 /nix/store/cqxv78mdflizg9hqa3k5vrf0s25cjcnr-modemmanager-1.24.0/sbin/ModemManager \
    --test-quick-suspend-resume \
    --log-level=INFO &
MM_PID=$!
echo "ModemManager started with PID: $MM_PID"

# Wait for initial startup
sleep 10

# Force scan multiple times to catch more modems
echo "Forcing multiple scan passes..."
for i in {1..10}; do
    echo "Scan pass $i..."
    mmcli --scan-modems 2>/dev/null || true
    sleep 5

    COUNT=$(mmcli -L 2>/dev/null | wc -l || echo "0")
    echo "  Detected: $COUNT modems"

    if [ "$COUNT" -ge 50 ]; then
        echo "✅ Successfully detected $COUNT modems!"
        break
    fi
done

# Final count
FINAL_COUNT=$(mmcli -L 2>/dev/null | wc -l || echo "0")
echo ""
echo "=========================================="
echo "Final Results: $FINAL_COUNT modems detected"
echo "=========================================="

# List first 10 modems
echo ""
echo "First 10 detected modems:"
mmcli -L 2>/dev/null | head -10

echo ""
echo "To make this permanent, run:"
echo "  systemctl stop ModemManager"
echo "  kill $MM_PID"
echo "  systemctl start ModemManager"