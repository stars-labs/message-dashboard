# Orange Pi NixOS Setup Guide

Complete guide for setting up SMS Dashboard Daemon on Orange Pi running NixOS.

## Prerequisites

- Orange Pi with NixOS installed
- 3G/4G USB modems connected
- Internet connectivity
- API key from SMS Dashboard

## Quick Setup

### 1. Add to your `configuration.nix`:

```nix
{ config, pkgs, ... }:

let
  sms-dashboard-daemon = pkgs.fetchFromGitHub {
    owner = "your-username";
    repo = "sms-dashboard";
    rev = "main";
    sha256 = "0000000000000000000000000000000000000000000000000000";
  };
in
{
  imports = [
    "${sms-dashboard-daemon}/orange-pi-daemon/nixos-module.nix"
  ];

  # Enable SMS Dashboard Daemon
  services.sms-dashboard-daemon = {
    enable = true;
    apiUrl = "https://sexy.qzz.io";
    apiKey = "your-api-key-here"; # Better to use secrets management
    uploadInterval = 60;
  };

  # Enable ModemManager
  services.modemmanager.enable = true;
  
  # NetworkManager for connectivity
  networking.networkmanager.enable = true;
  
  # USB modem support
  boot.kernelModules = [ "option" "usb_wwan" "cdc_ether" "cdc_ncm" ];
  
  # USB mode switching
  services.udev.packages = [ pkgs.usb-modeswitch ];
}
```

### 2. Using Flakes (Recommended)

Create `flake.nix`:

```nix
{
  description = "Orange Pi SMS Gateway";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    sms-dashboard.url = "github:your-username/sms-dashboard";
  };

  outputs = { self, nixpkgs, sms-dashboard }: {
    nixosConfigurations.orangepi = nixpkgs.lib.nixosSystem {
      system = "aarch64-linux";
      modules = [
        ./hardware-configuration.nix
        sms-dashboard.nixosModules.default
        {
          services.sms-dashboard-daemon = {
            enable = true;
            apiKey = "your-api-key";
          };
        }
      ];
    };
  };
}
```

### 3. Secure API Key Management

Using agenix:

```nix
{
  age.secrets.sms-api-key = {
    file = ./secrets/sms-api-key.age;
    owner = "sms-daemon";
  };
  
  services.sms-dashboard-daemon.apiKey = config.age.secrets.sms-api-key.path;
}
```

## Manual Build and Test

### Build the daemon:

```bash
# Clone the repository
git clone https://github.com/your-username/sms-dashboard.git
cd sms-dashboard/orange-pi-daemon

# Enter development shell
nix develop

# Build
zig build -Doptimize=ReleaseSafe

# Test run
SMS_API_KEY=your-key ./zig-out/bin/sms-dashboard-daemon
```

## Modem Configuration

### Supported Modems

- Huawei E3372, E3276, E8372
- ZTE MF823, MF831
- Quectel EC25, EG25-G
- Sierra Wireless MC7455

### USB Mode Switch Rules

Add to your configuration.nix:

```nix
services.udev.extraRules = ''
  # Huawei E3372
  ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="12d1", ATTRS{idProduct}=="1f01", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 12d1 -p 1f01 -M '55534243123456780000000000000011062000000100000000000000000000'"
  
  # ZTE MF823
  ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="19d2", ATTRS{idProduct}=="0257", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 19d2 -p 0257 -W"
'';
```

## Monitoring

### Check daemon status:

```bash
systemctl status sms-dashboard-daemon
```

### View logs:

```bash
# Real-time logs
journalctl -u sms-dashboard-daemon -f

# Last 100 lines
journalctl -u sms-dashboard-daemon -n 100

# Logs from last hour
journalctl -u sms-dashboard-daemon --since "1 hour ago"
```

### Test modems:

```bash
# List all modems
mmcli -L

# Check modem 0 details
mmcli -m 0

# Signal strength
mmcli -m 0 --signal-get

# List SMS
mmcli -m 0 --messaging-list-sms

# Read SMS 0
mmcli -m 0 --sms 0
```

## Troubleshooting

### Modem not detected

1. Check USB connection:
   ```bash
   lsusb
   ```

2. Check kernel modules:
   ```bash
   lsmod | grep -E "option|usb_wwan|cdc"
   ```

3. Restart ModemManager:
   ```bash
   systemctl restart ModemManager
   ```

### No signal

1. Check antenna connection
2. Verify SIM card is active
3. Check APN settings:
   ```bash
   mmcli -m 0 --simple-connect="apn=your-apn"
   ```

### Messages not uploading

1. Check API connectivity:
   ```bash
   curl -H "X-API-Key: your-key" https://sexy.qzz.io/api/control/phones
   ```

2. Check daemon logs for errors:
   ```bash
   journalctl -u sms-dashboard-daemon -p err
   ```

## Performance Tuning

### For multiple modems:

```nix
services.sms-dashboard-daemon = {
  uploadInterval = 30; # Faster polling
};

# Increase ModemManager limits
systemd.services.ModemManager.serviceConfig = {
  LimitNOFILE = 4096;
};
```

### For low-power operation:

```nix
services.sms-dashboard-daemon = {
  uploadInterval = 300; # 5 minutes
};

# CPU governor
powerManagement.cpuFreqGovernor = "ondemand";
```

## API Usage

The daemon automatically:
1. Discovers all connected modems
2. Monitors signal strength
3. Collects incoming SMS messages
4. Uploads to dashboard API
5. Deletes messages after successful upload

API endpoints used:
- `POST /api/control/messages` - Upload SMS
- `POST /api/control/phones` - Update phone status

View API docs: https://sexy.qzz.io/api-docs