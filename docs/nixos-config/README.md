# NixOS Configuration for SMS Dashboard

This directory contains all NixOS configuration files for the SMS Dashboard project.

## Structure

```
nixos-config/
├── README.md                    # This file
├── orange-pi/                   # Orange Pi specific configuration
│   ├── configuration.nix        # Main Orange Pi config
│   ├── hardware-configuration.nix # Hardware config (auto-generated)
│   └── flake.nix               # Flake for Orange Pi
├── modules/                     # Reusable NixOS modules
│   ├── sms-dashboard-daemon.nix # SMS daemon service module
│   └── modem-support.nix       # Modem/ModemManager configuration
└── secrets/                     # SOPS encrypted secrets
    ├── README.md               # Secrets documentation
    ├── orange-pi.yaml          # Orange Pi secrets
    └── .sops.yaml              # SOPS configuration

```

## Usage

### For Orange Pi deployment:

```bash
# Copy the configuration to the Orange Pi
sudo cp orange-pi/configuration.nix /etc/nixos/
sudo cp orange-pi/hardware-configuration.nix /etc/nixos/  # if needed
sudo cp -r modules /etc/nixos/
sudo cp -r secrets /etc/nixos/

# Rebuild the system
sudo nixos-rebuild switch
```

### For development/testing:

Use the flake.nix in the orange-pi directory:

```bash
cd orange-pi/
nixos-rebuild switch --flake .#orange-pi
```

## Features

- **Modular design**: Separate modules for different functionality
- **SOPS integration**: Secure secret management
- **Modem support**: Full ModemManager and 3G/4G modem support
- **SMS Dashboard Daemon**: Automatic SMS collection and forwarding
- **Network configuration**: Static IP setup for Orange Pi