#!/bin/bash

echo "=== Modem Detection Debug Script ==="
echo ""

echo "1. Checking if ModemManager is running:"
systemctl status ModemManager | head -n 5
echo ""

echo "2. Listing modems with mmcli -L:"
mmcli -L
echo ""

echo "3. Checking mmcli executable:"
which mmcli
ls -la $(which mmcli)
echo ""

echo "4. Getting detailed modem info:"
for i in 0 1 2 3 4; do
    echo "--- Modem $i ---"
    mmcli -m $i 2>/dev/null | grep -E "(path:|Numbers:|own:|primary sim path:)" || echo "Modem $i not found"
done
echo ""

echo "5. Getting SIM info:"
for i in 0 1 2 3 4; do
    echo "--- SIM $i ---"
    mmcli -i $i 2>/dev/null | grep -E "(path:|iccid:|operator)" || echo "SIM $i not found"
done
echo ""

echo "6. Running daemon modem detection command:"
mmcli -L | grep "/Modem/" | awk -F'/Modem/' '{print $2}' | awk '{print $1}'
echo ""

echo "7. Checking daemon environment:"
echo "USER: $USER"
echo "PATH: $PATH"
echo ""

echo "8. Checking D-Bus access:"
busctl --system list | grep -i modem
echo ""

echo "=== End Debug ==="