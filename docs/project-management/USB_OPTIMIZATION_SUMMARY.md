# USB Optimization Summary for 100 Modems

## Changes Successfully Deployed

### 1. Memory Limits (Applied Immediately)
✅ **MemoryMax**: 2GB (verified: 2147483648 bytes)
✅ **LimitNOFILE**: 65536 file descriptors
✅ **LimitAS**: 4GB address space
✅ **LimitDATA**: 3GB data segment

### 2. Kernel Parameters (Requires Reboot)
These parameters were added to boot configuration:
- `usbcore.usbfs_memory_mb=256` - Increases USB buffer from 16MB to 256MB
- `usbcore.autosuspend=-1` - Disables USB autosuspend completely
- `log_buf_len=4M` - Larger kernel log buffer for debugging
- `elevator=noop` - Optimized I/O scheduler for throughput
- `fs.file-max=2097152` - System-wide file handle limit
- `fs.nr_open=1048576` - Per-process file handle limit

### 3. Sysctl Optimizations (Applied)
- VM dirty ratios optimized for USB throughput
- Network buffers increased to 128MB
- Inotify limits increased for monitoring devices
- Process limits increased (pid_max=4194304)

### 4. Udev Rules (Applied)
- USB hub autosuspend disabled
- Modem device autosuspend disabled
- Power management set to "always on"
- Device timeout increased to 60 seconds

## Verification Commands

Once the Orange Pi is back online (203.116.95.146), run these checks:

```bash
# Check if kernel parameters applied
ssh root@203.116.95.146 'cat /proc/cmdline | grep usbcore'

# Verify USB buffer size (should be 256)
ssh root@203.116.95.146 'cat /sys/module/usbcore/parameters/usbfs_memory_mb'

# Check USB autosuspend (should be -1)
ssh root@203.116.95.146 'cat /sys/module/usbcore/parameters/autosuspend'

# Count USB modems
ssh root@203.116.95.146 'lsusb | grep -E "12d1|2c7c|05c6|1a86" | wc -l'

# Check SMS daemon status
ssh root@203.116.95.146 'systemctl status sms-daemon'

# Monitor memory usage
ssh root@203.116.95.146 'free -h'

# Check for any OOM kills
ssh root@203.116.95.146 'dmesg | grep -i "killed process"'
```

## Performance Testing

Run the USB performance optimization script:
```bash
ssh root@203.116.95.146 '/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/scripts/optimize-usb-performance.sh'
```

This will:
- Apply runtime USB optimizations
- Create `fast-lsusb` command for cached results
- Create `monitor-modems` for real-time monitoring
- Optimize CPU affinity for USB interrupts

## Expected Results

After all optimizations:
- lsusb should handle 100 modems without timeouts
- No OOM kills with 2GB memory limit
- All 100 EC20 modems should remain connected
- File descriptor limit won't be exhausted
- USB devices won't auto-suspend or disconnect

## Troubleshooting

If the Orange Pi doesn't come back online:
1. It may need physical power cycle
2. Kernel parameters might have caused boot issues
3. Check console/serial output if available

To rollback if needed:
1. Boot with previous generation: Hold Shift during boot
2. Remove problematic kernel parameters
3. Rebuild and deploy again

## Files Changed

1. `/nixos-config/orange-pi/configuration.nix` - Added kernel params and sysctl
2. `/nixos-config/modules/sms-daemon.nix` - Increased memory limits, added udev rules
3. Created `/deploy-remote.sh` - Remote deployment script
4. Created `/scripts/optimize-usb-performance.sh` - Runtime optimizations

All changes are committed to git repository.