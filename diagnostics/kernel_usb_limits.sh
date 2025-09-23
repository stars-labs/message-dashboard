#!/bin/bash

# Linux Kernel USB Subsystem Analysis
# Check kernel limits and resource exhaustion

echo "=== Kernel USB Subsystem Analysis ==="
echo "Timestamp: $(date)"
echo

# 1. Current kernel USB parameters
echo "USB Kernel Parameters:"
echo "usbfs_memory_mb: $(cat /sys/module/usbcore/parameters/usbfs_memory_mb 2>/dev/null || echo 'not found')"
echo "autosuspend: $(cat /sys/module/usbcore/parameters/autosuspend 2>/dev/null || echo 'not found')"
echo "use_both_schemes: $(cat /sys/module/usbcore/parameters/use_both_schemes 2>/dev/null || echo 'not found')"
echo

# 2. USB memory usage
echo "USB Memory Usage:"
if [ -f /proc/slabinfo ]; then
    echo "USB-related slab allocations:"
    grep -i usb /proc/slabinfo | while read line; do
        name=$(echo $line | awk '{print $1}')
        active=$(echo $line | awk '{print $2}')
        total=$(echo $line | awk '{print $3}')
        obj_size=$(echo $line | awk '{print $4}')
        echo "  $name: $active/$total objects (${obj_size}B each)"
    done
else
    echo "/proc/slabinfo not accessible"
fi
echo

# 3. USB device limits
echo "USB Device Enumeration Status:"
total_usb_devices=$(lsusb | wc -l)
echo "Total USB devices: $total_usb_devices"

# Count by bus
echo "Devices per USB bus:"
lsusb | awk '{print $2}' | sort | uniq -c | while read count bus; do
    echo "  Bus $bus: $count devices"
done
echo

# 4. File descriptor usage
echo "File Descriptor Usage:"
if [ -d /proc/self/fd ]; then
    total_fds=$(ls /proc/self/fd | wc -l)
    echo "Current process FDs: $total_fds"
fi

# System-wide FD usage
if [ -f /proc/sys/fs/file-nr ]; then
    fd_info=$(cat /proc/sys/fs/file-nr)
    echo "System FDs (allocated/unused/max): $fd_info"
fi

# Check USB-specific FDs
echo "USB device files in /dev:"
usb_dev_count=$(find /dev -name "ttyUSB*" 2>/dev/null | wc -l)
echo "  ttyUSB devices: $usb_dev_count"

cdc_dev_count=$(find /dev -name "cdc-*" 2>/dev/null | wc -l)
echo "  CDC devices: $cdc_dev_count"
echo

# 5. IRQ statistics for USB controllers
echo "USB Controller IRQ Statistics:"
if [ -f /proc/interrupts ]; then
    echo "USB-related interrupts:"
    grep -i "usb\|xhci\|ehci\|ohci" /proc/interrupts | while read line; do
        irq=$(echo $line | awk '{print $1}' | tr -d ':')
        desc=$(echo $line | awk '{for(i=2;i<=NF;i++) printf "%s ", $i; print ""}')
        echo "  IRQ $irq: $desc"
    done
else
    echo "/proc/interrupts not accessible"
fi
echo

# 6. USB controller status in sysfs
echo "USB Controller Hardware Status:"
find /sys/bus/pci/devices -name "*usb*" -o -name "*USB*" 2>/dev/null | \
    head -10 | while read controller; do
        if [ -f "$controller/device" ] && [ -f "$controller/vendor" ]; then
            device_id=$(cat "$controller/device" 2>/dev/null)
            vendor_id=$(cat "$controller/vendor" 2>/dev/null)
            echo "Controller: $vendor_id:$device_id"
        fi
    done
echo

# 7. Kernel USB driver modules
echo "Loaded USB Kernel Modules:"
lsmod | grep -E "usb|hci" | awk '{printf "  %-20s %s\n", $1, $2}'
echo

# 8. USB enumeration timing
echo "USB Enumeration Errors (kernel log):"
dmesg | grep -E "usb.*enumerat|usb.*timeout|usb.*unable" | tail -10
echo

# 9. Memory pressure indicators
echo "Memory Pressure Indicators:"
if [ -f /proc/meminfo ]; then
    echo "Memory summary:"
    grep -E "MemTotal|MemFree|MemAvailable|Buffers|Cached" /proc/meminfo
fi

# Check for USB-related OOM events
echo "USB-related memory events:"
dmesg | grep -E "usb.*memory|usb.*alloc|out of memory.*usb" | tail -5

# 10. USB core debugging information
echo "USB Core Debug Info:"
if [ -d /sys/kernel/debug/usb ]; then
    echo "USB debug filesystem available at /sys/kernel/debug/usb"
    if [ -r /sys/kernel/debug/usb/devices ]; then
        device_count=$(cat /sys/kernel/debug/usb/devices | grep "^T:" | wc -l)
        echo "Devices in USB debug: $device_count"
    fi
else
    echo "USB debug filesystem not available (requires debugfs mount)"
fi