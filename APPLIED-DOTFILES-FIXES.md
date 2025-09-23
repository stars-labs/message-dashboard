# Applied Dotfiles USB/Network Fixes

## Changes Applied from ~/dotfiles Configuration

### 1. USB Controller Stability Fix
**File**: `nixos-config/orange-pi/configuration.nix`
- Added `xhci_hcd.quirks=270336` kernel parameter (line 318)
- This critical USB controller quirk from your game system improves stability with multiple USB devices

### 2. Comprehensive USB Optimization Module
**File**: `nixos-config/modules/usb-optimization.nix` (NEW)
- **Kernel Module Options**:
  - USB core timing and descriptor timeouts
  - xHCI quirks (270336) for controller stability
  - EHCI optimizations for USB 2.0
  - USB storage quirks for EC25 modems

- **udev Rules**:
  - Disable autosuspend for all Quectel modems
  - Increase buffer sizes for USB serial devices
  - Set USB power persistence

- **Systemd Service**:
  - Runtime USB optimization at boot
  - Hub power management
  - Modem-specific power settings

- **ModemManager Tuning**:
  - Increased file/process limits (65536/32768)
  - CPU priority adjustment (Nice=-5)
  - TTY filtering for performance

### 3. Network Management with systemd-resolved
**File**: `nixos-config/orange-pi/configuration.nix`
- Added NetworkManager with systemd-resolved integration (lines 515-519)
- Configured systemd-resolved with:
  - DNSSEC with fallback
  - Opportunistic DNS over TLS
  - LLMNR disabled for security
  - DNS caching enabled

## Key Improvements

1. **USB Stability**: xHCI controller quirk addresses USB disconnection issues
2. **Power Management**: Persistent USB power prevents modem dropouts
3. **Performance**: ModemManager optimization for handling 100 modems
4. **DNS Resolution**: Modern DNS stack with security features
5. **Network Management**: NetworkManager for better network handling

## Deployment Command

```bash
# Deploy all changes to Orange Pi
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@10.171.150.102 \
    --build-host root@10.171.150.102 \
    --impure
```

## Expected Results

- Improved USB device stability (reduced disconnections)
- Better handling of 100 USB modems simultaneously
- Faster DNS resolution with caching
- Reduced ModemManager QMI errors
- Lower CPU usage from optimized polling

## Files Modified

1. `nixos-config/orange-pi/configuration.nix` - Added USB quirk, NetworkManager, resolved
2. `nixos-config/modules/usb-optimization.nix` - NEW comprehensive USB optimization module

## Next Steps

After deployment, monitor with:
```bash
# Check USB status
lsusb | grep -c EC25
mmcli -L | grep -c Modem

# Monitor system
sudo ./diagnostics/usb-health-monitor.sh
```