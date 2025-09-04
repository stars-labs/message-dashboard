# Migration Guide

This guide helps you migrate from the old scattered configuration files to the new structured NixOS configuration.

## What was moved:

### Old structure:
```
message-dashboard/
├── configuration.nix              # Main system config (duplicate)
├── hardware-configuration.nix     # Hardware config  
├── flake.nix                      # Flake config
├── orange-pi-daemon/
│   ├── configuration.nix          # Orange Pi config (duplicate)
│   ├── nixos-module.nix           # SMS daemon module
│   └── src/main.zig              # Daemon source
└── secrets/                       # SOPS secrets
```

### New structure:
```
nixos-config/
├── orange-pi/
│   ├── configuration.nix          # Clean Orange Pi config
│   ├── flake.nix                  # Orange Pi flake
│   └── hardware-configuration.nix # Copy from old location
├── modules/
│   ├── sms-daemon.nix             # SMS daemon service module  
│   ├── modem-support.nix          # Modem configuration
│   └── sms-daemon-package.nix     # Daemon package definition
└── secrets/                       # SOPS secrets
```

## Migration steps for Orange Pi:

1. **Copy the new configuration to Orange Pi:**
   ```bash
   # On your development machine
   scp -r nixos-config/ root@10.171.150.102:/tmp/
   
   # On Orange Pi
   sudo cp -r /tmp/nixos-config/* /etc/nixos/
   sudo cp /etc/nixos/orange-pi/configuration.nix /etc/nixos/configuration.nix
   ```

2. **Update the service name in any existing configs:**
   - Old: `services.sms-dashboard-daemon`
   - New: `services.sms-daemon`

3. **Rebuild the system:**
   ```bash
   sudo nixos-rebuild switch
   ```

4. **Verify the service:**
   ```bash
   systemctl status sms-daemon
   journalctl -fu sms-daemon
   ```

## Key improvements:

1. **Fixed PATH issue**: The `sms-daemon` service now includes `modemmanager` in its PATH, fixing the `FileNotFound` error.

2. **Modular design**: Configuration is split into reusable modules.

3. **Clear naming**: Service is now called `sms-daemon` instead of `sms-dashboard-daemon`.

4. **Better organization**: All NixOS configs are in one place.

5. **SOPS integration**: Secure secret management is properly configured.

## Troubleshooting:

If the service still fails, check:
```bash
# Verify mmcli is accessible
sudo -u sms-daemon mmcli -L

# Check the service path
systemctl show sms-daemon -p Path

# View detailed logs
journalctl -xeu sms-daemon
```