# Using sops-nix with SMS Dashboard Daemon

This guide shows how to securely manage the API key using sops-nix.

## Initial Setup

### 1. Install sops-nix

Add to your flake inputs:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    sops-nix.url = "github:Mic92/sops-nix";
    sms-dashboard.url = "github:your-username/sms-dashboard";
  };
  
  outputs = { self, nixpkgs, sops-nix, sms-dashboard, ... }: {
    nixosConfigurations.orangepi = nixpkgs.lib.nixosSystem {
      system = "aarch64-linux";
      modules = [
        sops-nix.nixosModules.sops
        sms-dashboard.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

### 2. Generate Age Key

On the Orange Pi:

```bash
# Create sops directory
sudo mkdir -p /var/lib/sops-nix

# Generate age key
nix-shell -p age --run "age-keygen -o /tmp/age-key.txt"

# Move to sops directory
sudo mv /tmp/age-key.txt /var/lib/sops-nix/key.txt
sudo chmod 600 /var/lib/sops-nix/key.txt

# Get the public key (you'll need this)
sudo cat /var/lib/sops-nix/key.txt | grep "public key:"
```

### 3. Create Secrets File

On your development machine:

Create `.sops.yaml`:

```yaml
creation_rules:
  - path_regex: secrets\.yaml$
    age: age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # Your public key
```

Create `secrets.yaml`:

```yaml
sms-dashboard:
  api-key: your-actual-api-key-here
```

Encrypt the file:

```bash
nix-shell -p sops age -run "sops -e -i secrets.yaml"
```

### 4. Configure NixOS

In your `configuration.nix`:

```nix
{ config, pkgs, ... }:

{
  imports = [
    ./sms-dashboard-daemon/nixos-module.nix
  ];

  # Sops configuration
  sops = {
    defaultSopsFile = ./secrets.yaml;
    age.keyFile = "/var/lib/sops-nix/key.txt";
    
    secrets = {
      "sms-dashboard/api-key" = {
        owner = "sms-daemon";
        group = "dialout";
        mode = "0440";
      };
    };
  };

  # SMS Dashboard Daemon with apiKeyFile
  services.sms-dashboard-daemon = {
    enable = true;
    apiUrl = "https://sexy.qzz.io";
    apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
    uploadInterval = 60;
  };
}
```

## Alternative: Using systemd credentials

If you prefer systemd's credential system:

```nix
{
  systemd.services.sms-dashboard-daemon = {
    serviceConfig = {
      LoadCredential = "api-key:/run/secrets/sms-api-key";
    };
    
    script = ''
      export SMS_API_KEY="$(cat $CREDENTIALS_DIRECTORY/api-key)"
      exec ${pkgs.sms-dashboard-daemon}/bin/sms-dashboard-daemon
    '';
  };
}
```

## Managing Multiple Orange Pi Devices

For multiple devices with different API keys:

### 1. Create host-specific secrets:

```yaml
# secrets.yaml
orangepi-1:
  sms-api-key: api-key-for-device-1
orangepi-2:
  sms-api-key: api-key-for-device-2
orangepi-3:
  sms-api-key: api-key-for-device-3
```

### 2. Use in configuration:

```nix
{
  sops.secrets."${config.networking.hostName}/sms-api-key" = {
    owner = "sms-daemon";
  };
  
  services.sms-dashboard-daemon = {
    enable = true;
    apiKeyFile = config.sops.secrets."${config.networking.hostName}/sms-api-key".path;
  };
}
```

## Security Best Practices

### 1. Restrict secret access:

```nix
sops.secrets."sms-dashboard/api-key" = {
  owner = "sms-daemon";
  group = "dialout";
  mode = "0440";  # Read-only for owner and group
  restartUnits = [ "sms-dashboard-daemon.service" ];
};
```

### 2. Use separate keys per device:

```bash
# Generate unique age key for each Orange Pi
age-keygen -o orangepi-1-key.txt
age-keygen -o orangepi-2-key.txt
```

### 3. Rotate keys regularly:

```bash
# Generate new API key in dashboard
# Update secrets.yaml
sops -e -i secrets.yaml
# Deploy to Orange Pi
nixos-rebuild switch --flake .#orangepi
```

## Troubleshooting

### Check if secret is accessible:

```bash
sudo -u sms-daemon cat /run/secrets/sms-dashboard/api-key
```

### Verify sops is working:

```bash
sudo sops -d /etc/sops/secrets.yaml
```

### Check service environment:

```bash
sudo systemctl show sms-dashboard-daemon -p Environment
```

### Debug secret loading:

```nix
systemd.services.sms-dashboard-daemon = {
  serviceConfig.ExecStartPre = "${pkgs.coreutils}/bin/test -r $CREDENTIALS_DIRECTORY/api-key";
};
```

## Example: Complete Setup Script

```bash
#!/usr/bin/env bash
set -e

# 1. Generate age key
sudo mkdir -p /var/lib/sops-nix
sudo age-keygen | sudo tee /var/lib/sops-nix/key.txt
sudo chmod 600 /var/lib/sops-nix/key.txt

# 2. Get public key
PUBLIC_KEY=$(sudo grep "public key:" /var/lib/sops-nix/key.txt | cut -d' ' -f4)
echo "Your public key: $PUBLIC_KEY"
echo "Add this to .sops.yaml on your development machine"

# 3. After creating and encrypting secrets.yaml, deploy:
# nixos-rebuild switch --flake .#orangepi
```