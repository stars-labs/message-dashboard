# SMS Dashboard Daemon for Orange Pi

A lightweight daemon written in Zig that monitors SMS messages and modem status on Orange Pi devices and uploads them to the SMS Dashboard API.

## Features

- 🚀 Written in Zig for maximum performance and minimal resource usage
- 📱 Supports multiple modems simultaneously
- 📊 Uploads SMS messages and signal strength data
- 🔄 Automatic retry and error handling
- 🛡️ Systemd integration with security hardening
- ❄️ NixOS module for easy deployment

## Requirements

- NixOS (recommended) or any Linux distribution
- ModemManager installed and running
- 3G/4G USB modems connected to Orange Pi
- Internet connectivity

## Installation

### Using NixOS Flakes (Recommended)

1. Add to your `flake.nix`:

```nix
{
  inputs = {
    sms-dashboard-daemon.url = "github:your-username/sms-dashboard-daemon";
  };

  outputs = { self, nixpkgs, sms-dashboard-daemon, ... }: {
    nixosConfigurations.orangepi = nixpkgs.lib.nixosSystem {
      system = "aarch64-linux";
      modules = [
        sms-dashboard-daemon.nixosModules.default
        {
          services.sms-dashboard-daemon = {
            enable = true;
            apiUrl = "https://sexy.qzz.io";
            apiKey = "your-api-key-here";
          };
        }
      ];
    };
  };
}
```

2. Deploy:
```bash
nixos-rebuild switch --flake .#orangepi
```

### Manual Installation

1. Build the daemon:
```bash
nix build
# or
zig build -Doptimize=ReleaseSafe
```

2. Run manually:
```bash
SMS_API_KEY=your-api-key ./zig-out/bin/sms-dashboard-daemon
```

## Configuration

### Environment Variables

- `SMS_API_URL`: API endpoint (default: https://sexy.qzz.io)
- `SMS_API_KEY`: Your API key (required)
- `SMS_UPLOAD_INTERVAL`: Upload interval in seconds (default: 60)

### NixOS Module Options

```nix
services.sms-dashboard-daemon = {
  enable = true;
  apiUrl = "https://sexy.qzz.io";
  apiKey = "your-api-key"; # Use secrets management!
  uploadInterval = 60;
  user = "sms-daemon";
  group = "dialout";
};
```

## Secrets Management

For production use, store the API key securely:

### Using agenix

```nix
age.secrets.sms-api-key = {
  file = ./secrets/sms-api-key.age;
  owner = "sms-daemon";
};

services.sms-dashboard-daemon.apiKey = config.age.secrets.sms-api-key.path;
```

### Using sops-nix

```nix
sops.secrets."sms-dashboard/api-key" = {
  owner = "sms-daemon";
};

services.sms-dashboard-daemon.apiKey = config.sops.secrets."sms-dashboard/api-key".path;
```

## Modem Support

The daemon uses ModemManager and supports most 3G/4G USB modems:

- Huawei E3372, E3276, E8372
- ZTE MF823, MF831
- Sierra Wireless modems
- Quectel modems
- And many more...

### Testing Modem Connection

```bash
# List modems
mmcli -L

# Get modem details
mmcli -m 0

# Check signal
mmcli -m 0 --signal-get

# List SMS messages
mmcli -m 0 --messaging-list-sms
```

## Development

### Development Shell

```bash
nix develop
# Now you have zig, zls, and mmcli available
```

### Building

```bash
zig build
```

### Running Tests

```bash
zig build test
```

## Architecture

The daemon:
1. Discovers all connected modems via ModemManager
2. Polls each modem for signal strength and SMS messages
3. Batches and uploads data to the API
4. Marks messages as read after successful upload
5. Sleeps for the configured interval

## Monitoring

View daemon logs:
```bash
journalctl -u sms-dashboard-daemon -f
```

Check daemon status:
```bash
systemctl status sms-dashboard-daemon
```

## Troubleshooting

### Daemon not starting

1. Check ModemManager is running:
   ```bash
   systemctl status ModemManager
   ```

2. Verify modem is detected:
   ```bash
   mmcli -L
   ```

3. Check permissions:
   ```bash
   groups sms-daemon
   # Should include: dialout networkmanager
   ```

### No messages uploading

1. Check API connectivity:
   ```bash
   curl https://sexy.qzz.io/api-docs
   ```

2. Verify API key:
   ```bash
   curl -H "X-API-Key: your-key" https://sexy.qzz.io/api/control/phones
   ```

3. Check daemon logs for errors:
   ```bash
   journalctl -u sms-dashboard-daemon --since "1 hour ago"
   ```

## Performance

- Memory usage: ~5-10MB
- CPU usage: <1% (spikes during upload)
- Network: Minimal (JSON API calls)
- Supports 10+ modems simultaneously

## License

MIT License - See LICENSE file for details