#!/usr/bin/env bash
# USB Performance Optimization Script for 100 Modems
# Run this on the Orange Pi after deployment

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}USB Performance Optimization for 100 Modems${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root${NC}"
    exit 1
fi

# Current USB statistics
echo -e "${YELLOW}Current USB Statistics:${NC}"
echo "USB devices connected: $(lsusb | wc -l)"
echo "Modem devices: $(lsusb | grep -E '12d1|2c7c|05c6|1a86' | wc -l)"
echo "USB buffer size: $(cat /sys/module/usbcore/parameters/usbfs_memory_mb)MB"
echo "USB autosuspend: $(cat /sys/module/usbcore/parameters/autosuspend)"
echo ""

# Optimize USB subsystem
echo -e "${YELLOW}Applying USB optimizations...${NC}"

# 1. Increase USB buffer for lsusb performance
echo "Setting USB buffer to 256MB..."
echo 256 > /sys/module/usbcore/parameters/usbfs_memory_mb

# 2. Disable USB autosuspend for all devices
echo "Disabling USB autosuspend..."
echo -1 > /sys/module/usbcore/parameters/autosuspend

# 3. Disable autosuspend for all USB hubs
for hub in /sys/bus/usb/devices/*/power/autosuspend; do
    if [ -f "$hub" ]; then
        echo -1 > "$hub" 2>/dev/null || true
    fi
done

# 4. Set all USB devices to always on
for device in /sys/bus/usb/devices/*/power/control; do
    if [ -f "$device" ]; then
        echo "on" > "$device" 2>/dev/null || true
    fi
done

# 5. Optimize kernel scheduler for USB interrupts
echo "Optimizing CPU affinity for USB interrupts..."
# Find USB interrupt lines and spread across CPUs
USB_IRQS=$(grep -E "xhci|ehci|ohci|uhci" /proc/interrupts | awk '{print $1}' | tr -d ':')
CPU_COUNT=$(nproc)
CPU_NUM=0

for IRQ in $USB_IRQS; do
    if [ -f "/proc/irq/$IRQ/smp_affinity_list" ]; then
        echo "$CPU_NUM" > "/proc/irq/$IRQ/smp_affinity_list" 2>/dev/null || true
        CPU_NUM=$(( (CPU_NUM + 1) % CPU_COUNT ))
    fi
done

# 6. Create fast lsusb wrapper
echo -e "${YELLOW}Creating optimized lsusb wrapper...${NC}"
cat > /usr/local/bin/fast-lsusb << 'EOF'
#!/bin/bash
# Fast lsusb wrapper with caching for 100 modems

CACHE_FILE="/tmp/lsusb_cache"
CACHE_AGE=2  # Cache for 2 seconds

# Check if cache exists and is fresh
if [ -f "$CACHE_FILE" ]; then
    if [ $(($(date +%s) - $(stat -c %Y "$CACHE_FILE"))) -lt $CACHE_AGE ]; then
        cat "$CACHE_FILE"
        exit 0
    fi
fi

# Generate new cache
lsusb > "$CACHE_FILE"
cat "$CACHE_FILE"
EOF

chmod +x /usr/local/bin/fast-lsusb

# 7. Create modem count monitoring script
echo -e "${YELLOW}Creating modem monitoring script...${NC}"
cat > /usr/local/bin/monitor-modems << 'EOF'
#!/bin/bash
# Monitor modem count and USB performance

watch -n1 '
echo "=== USB Modem Monitor ==="
echo ""
echo "USB Devices: $(lsusb | wc -l)"
echo "Modems (USB): $(lsusb | grep -E "12d1|2c7c|05c6|1a86" | wc -l)"
echo "Modems (MM): $(mmcli -L 2>/dev/null | grep -c "Modem/" || echo 0)"
echo ""
echo "USB Buffer: $(cat /sys/module/usbcore/parameters/usbfs_memory_mb)MB"
echo "File Descriptors: $(cat /proc/$(pgrep sms-daemon)/limits 2>/dev/null | grep "open files" | awk "{print \$4}")"
echo ""
echo "Memory Usage:"
free -h | grep -E "Mem|Swap"
echo ""
echo "Daemon Status:"
systemctl is-active sms-daemon || echo "Not running"
if pgrep sms-daemon > /dev/null; then
    ps aux | grep sms-daemon | grep -v grep | awk "{printf \"CPU: %s%% MEM: %s%%\n\", \$3, \$4}"
fi
'
EOF

chmod +x /usr/local/bin/monitor-modems

# 8. Optimize sysctl for USB performance
echo -e "${YELLOW}Applying sysctl optimizations...${NC}"
sysctl -w vm.dirty_ratio=5
sysctl -w vm.dirty_background_ratio=2
sysctl -w vm.swappiness=10
sysctl -w fs.file-max=2097152
sysctl -w fs.nr_open=1048576

# 9. Clear USB device cache
echo -e "${YELLOW}Clearing USB device cache...${NC}"
echo 0 > /sys/class/usb_device/usbdev*/device/authorized 2>/dev/null || true
sleep 1
echo 1 > /sys/class/usb_device/usbdev*/device/authorized 2>/dev/null || true

# Verify optimizations
echo ""
echo -e "${GREEN}Optimizations Applied!${NC}"
echo ""
echo -e "${YELLOW}New USB Statistics:${NC}"
echo "USB buffer size: $(cat /sys/module/usbcore/parameters/usbfs_memory_mb)MB"
echo "USB autosuspend: $(cat /sys/module/usbcore/parameters/autosuspend) (-1 = disabled)"
echo "File limit: $(ulimit -n)"
echo ""

# Test lsusb performance
echo -e "${YELLOW}Testing lsusb performance...${NC}"
TIME_START=$(date +%s%N)
lsusb > /dev/null
TIME_END=$(date +%s%N)
TIME_DIFF=$((($TIME_END - $TIME_START) / 1000000))
echo "lsusb execution time: ${TIME_DIFF}ms"

if [ $TIME_DIFF -gt 1000 ]; then
    echo -e "${YELLOW}Note: lsusb is still slow. Use 'fast-lsusb' for cached results${NC}"
else
    echo -e "${GREEN}lsusb performance is good!${NC}"
fi

echo ""
echo -e "${GREEN}Available commands:${NC}"
echo "  fast-lsusb       - Cached lsusb (updates every 2s)"
echo "  monitor-modems   - Real-time modem monitoring"
echo ""
echo -e "${GREEN}Optimization complete!${NC}"