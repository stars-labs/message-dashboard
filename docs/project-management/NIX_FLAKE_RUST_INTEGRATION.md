# Rust Daemon - Nix Flake Integration Guide

## Overview

This guide shows how to integrate the Rust SMS daemon into your existing Nix flake setup, allowing you to build and deploy it alongside or replace the Zig version.

## Current Flake Structure

Your flake already has:
- ✅ Orange Pi NixOS configuration
- ✅ SOPS secret management
- ✅ SMS daemon module
- ✅ Zig daemon builds (release + debug)

## Integration Strategy

We'll add the Rust daemon as a **parallel option**, allowing you to:
1. Build both Zig and Rust versions
2. Choose which to deploy via configuration
3. Easy rollback if needed

## Step 1: Create Rust Project (Do This First)

```bash
cd /path/to/message-dashboard

# Install Rust if not already installed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Create Rust project
cargo new --bin orange-pi-daemon-rust
cd orange-pi-daemon-rust

# Copy Cargo.toml from RUST_MIGRATION_PLAN.md
# Implement src/types.rs, src/modem_manager.rs, src/api_client.rs, src/main.rs

# Build to generate Cargo.lock (needed for Nix)
cargo build --release
```

## Step 2: Update flake.nix

Add the Rust daemon package to your existing flake:

```nix
# In flake.nix, add to perSystem's let block (around line 128):

perSystem = { config, self', inputs', pkgs, system, lib, ... }:
let
  daemonVersion = "4.0.0";
  
  # EXISTING: Zig daemon packages
  sms-daemon-base = { ... };
  sms-daemon = pkgs.stdenv.mkDerivation ( ... );
  sms-daemon-debug = pkgs.stdenv.mkDerivation ( ... );
  
  # NEW: Rust daemon package
  sms-daemon-rust = pkgs.rustPlatform.buildRustPackage {
    pname = "sms-daemon-rust";
    version = "1.0.0";
    
    src = ./orange-pi-daemon-rust;
    
    cargoLock = {
      lockFile = ./orange-pi-daemon-rust/Cargo.lock;
    };
    
    nativeBuildInputs = with pkgs; [ 
      pkg-config 
    ];
    
    buildInputs = with pkgs; [ 
      openssl
      dbus
    ];
    
    # Rename binary to match systemd service expectation
    postInstall = ''
      mv $out/bin/orange-pi-daemon-rust $out/bin/sms-daemon
    '';
    
    meta = with lib; {
      description = "SMS Dashboard Daemon (Rust) - Memory-safe replacement";
      longDescription = ''
        Memory-safe Rust rewrite of the SMS daemon. Monitors 3G/4G modems
        via ModemManager, collects SMS and status, forwards to API.
        Single-threaded async for simplicity and reliability.
      '';
      homepage = "https://github.com/hecoinfo/message-dashboard";
      license = licenses.mit;
      platforms = platforms.linux;
    };
  };
in
{
  packages = {
    inherit sms-daemon sms-daemon-debug;
    inherit sms-daemon-rust;  # ADD THIS LINE
    default = sms-daemon;
  };
  
  # ... rest of flake
}
```

## Step 3: Update NixOS Configuration

Modify the Orange Pi configuration to allow choosing between Zig and Rust:

```nix
# In flake.nix, around line 92-105, replace the services.sms-daemon block:

services.sms-daemon = {
  enable = true;
  
  # Choose which daemon to use
  package = 
    if config.services.sms-daemon.useRustDaemon then
      self.packages.aarch64-linux.sms-daemon-rust
    else if config.services.sms-daemon.debugBuild then
      self.packages.aarch64-linux.sms-daemon-debug
    else
      self.packages.aarch64-linux.sms-daemon;
  
  apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
  apiUrl = "https://sexy.qzz.io";
  
  # Rust daemon uses environment variables, not CLI args
  # Module will need updating to support this
  useRustDaemon = true;  # Set to true to use Rust, false for Zig
  
  # These only apply to Zig daemon
  phoneUpdateIntervalSeconds = 30;
  messageCheckIntervalMs = 50;
  signalCheckIntervalSeconds = 60;
  debugBuild = false;  # Only applies to Zig
};
```

## Step 4: Update SMS Daemon NixOS Module

The module needs to support both Zig (CLI args) and Rust (env vars):

```nix
# In nixos-config/modules/sms-daemon.nix

{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.sms-daemon;
in {
  options.services.sms-daemon = {
    enable = mkEnableOption "SMS Dashboard Daemon";
    
    package = mkOption {
      type = types.package;
      description = "SMS daemon package to use";
    };
    
    useRustDaemon = mkOption {
      type = types.bool;
      default = false;
      description = "Use Rust daemon instead of Zig daemon";
    };
    
    apiUrl = mkOption {
      type = types.str;
      default = "http://localhost:8787";
      description = "SMS Dashboard API URL";
    };
    
    apiKeyFile = mkOption {
      type = types.path;
      description = "Path to file containing API key";
    };
    
    # Zig-specific options (ignored by Rust daemon)
    phoneUpdateIntervalSeconds = mkOption {
      type = types.int;
      default = 30;
      description = "Phone status update interval (Zig only)";
    };
    
    messageCheckIntervalMs = mkOption {
      type = types.int;
      default = 50;
      description = "Message check interval in ms (Zig only)";
    };
    
    signalCheckIntervalSeconds = mkOption {
      type = types.int;
      default = 60;
      description = "Signal check interval (Zig only)";
    };
    
    debugBuild = mkOption {
      type = types.bool;
      default = false;
      description = "Use debug build (Zig only)";
    };
    
    user = mkOption {
      type = types.str;
      default = "sms-daemon";
      description = "User to run daemon as";
    };
    
    group = mkOption {
      type = types.str;
      default = "sms-daemon";
      description = "Group to run daemon as";
    };
  };
  
  config = mkIf cfg.enable {
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      extraGroups = [ "dialout" ];
      description = "SMS Dashboard Daemon user";
    };
    
    users.groups.${cfg.group} = {};
    
    systemd.services.sms-daemon = {
      description = "SMS Dashboard Daemon ${if cfg.useRustDaemon then "(Rust)" else "(Zig)"}";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "ModemManager.service" ];
      wants = [ "ModemManager.service" ];
      
      serviceConfig = {
        Type = "notify";
        User = cfg.user;
        Group = cfg.group;
        Restart = "always";
        RestartSec = "10s";
        
        # Memory limits
        MemoryMax = if cfg.useRustDaemon then "200M" else "500M";
        
        # Different ExecStart based on daemon type
        ExecStart = if cfg.useRustDaemon then
          # Rust daemon uses environment variables
          "${cfg.package}/bin/sms-daemon"
        else
          # Zig daemon uses CLI arguments
          ''
            ${cfg.package}/bin/sms-daemon \
              --api-url ${cfg.apiUrl} \
              --api-key-file ${cfg.apiKeyFile} \
              --phone-update-interval ${toString cfg.phoneUpdateIntervalSeconds} \
              --message-check-interval ${toString cfg.messageCheckIntervalMs} \
              --signal-check-interval ${toString cfg.signalCheckIntervalSeconds}
          '';
        
        # Environment variables (Rust daemon reads these)
        Environment = mkIf cfg.useRustDaemon [
          "SMS_API_URL=${cfg.apiUrl}"
          "RUST_LOG=info"
        ];
        
        # Rust daemon reads API key from file via env var
        EnvironmentFile = mkIf cfg.useRustDaemon cfg.apiKeyFile;
        
        # Service hardening
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ "/tmp" ];
      };
    };
    
    # Ensure ModemManager is available
    services.modemmanager.enable = true;
  };
}
```

## Step 5: Build and Test

### Local Build Test

```bash
# Build Rust daemon
nix build .#sms-daemon-rust

# Check the result
ls -lh result/bin/
./result/bin/sms-daemon --help  # Should fail gracefully (no args needed)
```

### Deploy to Orange Pi

```bash
# Deploy with Rust daemon enabled
nixos-rebuild switch \
    --flake .#orange-pi \
    --use-substitutes \
    --target-host root@203.116.95.146 \
    --build-host root@203.116.95.146 \
    --impure
```

### Verify on Orange Pi

```bash
# SSH to Orange Pi
ssh root@203.116.95.146

# Check service status
systemctl status sms-daemon

# Should see: "SMS Dashboard Daemon (Rust)"
# Check it's running the Rust binary
readlink /run/current-system/sw/bin/sms-daemon

# Watch logs
journalctl -u sms-daemon -f

# Should see:
# "🚀 Starting Rust SMS Daemon"
# "Building modem cache..."
# "Starting main loop with X modems"
```

## Step 6: Rollback Plan

If Rust daemon has issues, switch back to Zig:

```nix
# In flake.nix, change:
useRustDaemon = false;  # Switch back to Zig

# Redeploy
nixos-rebuild switch --flake .#orange-pi ...
```

## Environment Variables for Rust Daemon

The Rust daemon needs these environment variables:

1. **SMS_API_URL** - Set in module (already configured)
2. **SMS_API_KEY** - Read from apiKeyFile
3. **RUST_LOG** - Set to "info" (or "debug" for verbose)

### API Key Handling

The Zig daemon reads API key from a file passed as CLI arg.
The Rust daemon reads from an environment variable.

To bridge this, we use `EnvironmentFile`:

```bash
# On Orange Pi, the SOPS secret file should contain:
SMS_API_KEY=your-actual-api-key-here

# The module loads this as environment variables
```

## Development Workflow

### Develop Locally

```bash
# Enter dev shell with Rust tools
nix develop

# Work on Rust code
cd orange-pi-daemon-rust
cargo build
cargo test
cargo clippy

# Test locally (needs ModemManager)
export SMS_API_URL="https://sexy.qzz.io"
export SMS_API_KEY="test-key"
cargo run
```

### Build with Nix

```bash
# Build Rust daemon
nix build .#sms-daemon-rust

# Build Zig daemon (comparison)
nix build .#sms-daemon

# Compare sizes
ls -lh result/bin/sms-daemon
```

### Deploy and Test

```bash
# Deploy
./deploy-remote.sh  # Or manual nixos-rebuild

# Monitor
ssh root@203.116.95.146 'journalctl -u sms-daemon -f'
```

## Flake Outputs

After integration, your flake will provide:

```bash
# Packages
nix build .#sms-daemon          # Zig release
nix build .#sms-daemon-debug    # Zig debug  
nix build .#sms-daemon-rust     # Rust (new!)

# Apps
nix run .#sms-daemon            # Run Zig daemon
# TODO: Add sms-daemon-rust app

# Dev shells
nix develop                     # General dev
nix develop .#daemon            # Zig daemon dev
# TODO: Add Rust daemon dev shell
```

## Adding Rust Dev Shell (Optional)

Add to `perSystem.devShells`:

```nix
devShells = {
  default = pkgs.mkShell { ... };
  
  daemon = pkgs.mkShell { ... };  # Zig
  
  # NEW: Rust daemon dev shell
  daemon-rust = pkgs.mkShell {
    packages = with pkgs; [
      rustc
      cargo
      rust-analyzer
      rustfmt
      clippy
      pkg-config
      openssl
      dbus
      modemmanager
    ];
    
    shellHook = ''
      echo "Rust SMS Daemon Development"
      echo "Run 'cargo build' to compile"
      echo "Run 'cargo test' to run tests"
      echo "Run 'cargo clippy' for linting"
    '';
  };
};
```

## CI/CD Integration

If you have CI, update to build Rust daemon:

```yaml
# .github/workflows/build.yml or similar
jobs:
  build:
    steps:
      - name: Build Zig daemon
        run: nix build .#sms-daemon
      
      - name: Build Rust daemon
        run: nix build .#sms-daemon-rust
      
      - name: Compare sizes
        run: |
          echo "Zig size: $(stat -c%s result-zig/bin/sms-daemon)"
          echo "Rust size: $(stat -c%s result-rust/bin/sms-daemon)"
```

## Troubleshooting

### Problem: Cargo.lock not found

```
error: file 'orange-pi-daemon-rust/Cargo.lock' does not exist
```

**Solution**: Build the Rust project first to generate Cargo.lock:
```bash
cd orange-pi-daemon-rust
cargo build
```

### Problem: OpenSSL not found

```
error: failed to run custom build command for `openssl-sys`
```

**Solution**: Already fixed by adding `openssl` to buildInputs in flake.

### Problem: Wrong binary name

```
error: /nix/store/.../bin/orange-pi-daemon-rust not found
```

**Solution**: The `postInstall` renames it to `sms-daemon` to match systemd.

### Problem: API key not loading

Check the SOPS secret file format:

```bash
# SSH to Orange Pi
cat /run/secrets/sms-dashboard/api-key

# Should contain:
SMS_API_KEY=actual-key-value-here

# Not:
actual-key-value-here  # Wrong! Rust daemon won't find it
```

Update your SOPS secret to export the variable:
```yaml
# In nixos-config/secrets/orange-pi.yaml
sms-dashboard:
  api-key: ENC[...]  # Contents should be: SMS_API_KEY=yourkey
```

## Next Steps

1. ✅ Implement Rust daemon (see RUST_MIGRATION_PLAN.md)
2. ✅ Generate Cargo.lock (`cargo build`)
3. ✅ Update flake.nix (add sms-daemon-rust package)
4. ✅ Update NixOS module (support both daemons)
5. ✅ Update secrets format (SMS_API_KEY=...)
6. ✅ Test build locally (`nix build .#sms-daemon-rust`)
7. ✅ Deploy to Orange Pi with `useRustDaemon = true`
8. ✅ Monitor for 24 hours
9. ✅ Compare stability vs Zig version
10. ✅ Remove Zig code if successful

## Summary

With this integration:
- ✅ Both Zig and Rust daemons can be built
- ✅ Easy switching via `useRustDaemon` flag
- ✅ Proper SOPS secret handling
- ✅ Systemd integration with Type=notify
- ✅ Memory limits and hardening
- ✅ Clean rollback path

The Rust daemon should provide **zero crashes** and **better reliability** compared to the Zig version. 🦀
