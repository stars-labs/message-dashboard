# Rust Migration - Quick Start Guide

## Prerequisites

1. **Install Rust** (on your development machine):
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

2. **Verify Installation**:
```bash
rustc --version  # Should show: rustc 1.7x.x
cargo --version  # Should show: cargo 1.7x.x
```

## Phase 1: Create Project (10 minutes)

```bash
cd /path/to/message-dashboard
cargo new --bin orange-pi-daemon-rust
cd orange-pi-daemon-rust
```

## Phase 2: Set Up Dependencies (5 minutes)

Edit `Cargo.toml` - replace the entire file with:

```toml
[package]
name = "orange-pi-daemon-rust"
version = "1.0.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["rt", "time", "macros", "process"] }
reqwest = { version = "0.11", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
anyhow = "1"
thiserror = "1"
sd-notify = "0.4"
```

## Phase 3: Create Type Definitions (30 minutes)

Create `src/types.rs` with the content from `RUST_MIGRATION_PLAN.md` Phase 2.1.

Update `src/main.rs` to add:
```rust
mod types;
```

Test compilation:
```bash
cargo build
```

## Phase 4: Implement ModemManager (3 hours)

Create `src/modem_manager.rs` with the content from `RUST_MIGRATION_PLAN.md` Phase 3.1.

Update `src/main.rs`:
```rust
mod types;
mod modem_manager;
```

Test compilation:
```bash
cargo build
```

**Test with real hardware:**
```bash
# On Orange Pi, test individual functions
cargo run --example test_modem_manager

# Create src/examples/test_modem_manager.rs:
use orange_pi_daemon_rust::modem_manager::ModemManager;

#[tokio::main]
async fn main() {
    let mm = ModemManager::new();
    
    println!("Listing modems...");
    match mm.list_modems().await {
        Ok(modems) => {
            println!("Found {} modems", modems.len());
            for modem_id in modems {
                println!("  Modem: {}", modem_id);
                
                if let Ok(Some(iccid)) = mm.get_iccid(&modem_id).await {
                    println!("    ICCID: {}", iccid);
                }
            }
        }
        Err(e) => eprintln!("Error: {}", e),
    }
}
```

## Phase 5: Implement API Client (2 hours)

Create `src/api_client.rs` with content from `RUST_MIGRATION_PLAN.md` Phase 4.1.

Update `src/main.rs`:
```rust
mod types;
mod modem_manager;
mod api_client;
```

Test compilation:
```bash
cargo build
```

## Phase 6: Implement Main Loop (2 hours)

Replace `src/main.rs` with the content from `RUST_MIGRATION_PLAN.md` Phase 5.1.

Test compilation:
```bash
cargo build --release
```

## Phase 7: Test on Orange Pi (2 hours)

### 7.1 Build for ARM
```bash
# On development machine
cargo build --release --target aarch64-unknown-linux-gnu
```

Or build directly on Orange Pi:
```bash
# On Orange Pi
cd orange-pi-daemon-rust
cargo build --release
```

### 7.2 Test Run
```bash
# On Orange Pi
export SMS_API_URL="https://sexy.qzz.io"
export SMS_API_KEY="your-api-key-here"
export RUST_LOG="info"

./target/release/orange-pi-daemon-rust
```

### 7.3 Monitor Logs
```bash
# Watch for:
# - "Building modem cache"
# - "Starting main loop with X modems"
# - "Found X messages from modem Y"
# - "Uploaded X phone records"

# Should see NO:
# - Segmentation faults
# - Memory errors
# - Panics
```

## Phase 8: NixOS Integration (1 hour)

### 8.1 Create Nix Package

Create `nixos-config/orange-pi/sms-daemon-rust.nix`:

```nix
{ lib, rustPlatform, pkg-config, openssl }:

rustPlatform.buildRustPackage rec {
  pname = "orange-pi-daemon-rust";
  version = "1.0.0";
  
  src = ../../orange-pi-daemon-rust;
  
  cargoLock = {
    lockFile = ../../orange-pi-daemon-rust/Cargo.lock;
  };
  
  nativeBuildInputs = [ pkg-config ];
  buildInputs = [ openssl ];
  
  meta = with lib; {
    description = "SMS daemon for Orange Pi (Rust version)";
    license = licenses.mit;
  };
}
```

### 8.2 Update Configuration

In `nixos-config/orange-pi/configuration.nix`:

```nix
{ config, pkgs, ... }:

let
  sms-daemon-rust = pkgs.callPackage ./sms-daemon-rust.nix {};
in
{
  # ... existing config ...
  
  # Replace old service
  systemd.services.sms-daemon = {
    description = "SMS Dashboard Daemon (Rust)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" "ModemManager.service" ];
    
    serviceConfig = {
      Type = "notify";
      ExecStart = "${sms-daemon-rust}/bin/orange-pi-daemon-rust";
      Restart = "always";
      RestartSec = "10s";
      
      # Resource limits
      MemoryMax = "200M";
      
      Environment = [
        "SMS_API_URL=https://sexy.qzz.io"
        "SMS_API_KEY=${config.sops.secrets.sms-api-key.path}"
        "RUST_LOG=info"
      ];
    };
  };
}
```

### 8.3 Deploy

```bash
# On your development machine
cd /path/to/message-dashboard

# Generate Cargo.lock (needed for Nix)
cd orange-pi-daemon-rust
cargo build
cd ..

# Deploy to Orange Pi
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@203.116.95.146 \
    --build-host root@203.116.95.146 \
    --impure
```

### 8.4 Verify Deployment

```bash
# SSH to Orange Pi
ssh root@203.116.95.146

# Check service status
systemctl status sms-daemon

# Watch logs
journalctl -u sms-daemon -f

# Check memory usage
systemctl show sms-daemon | grep Memory
```

## Troubleshooting

### Build Errors

**Problem**: `error: linking with cc failed`
**Solution**: Install build dependencies:
```bash
apt install build-essential pkg-config libssl-dev
```

**Problem**: `failed to resolve: use of undeclared crate`
**Solution**: Make sure module is declared in main.rs:
```rust
mod types;
mod modem_manager;
mod api_client;
```

### Runtime Errors

**Problem**: `mmcli: command not found`
**Solution**: ModemManager must be installed:
```bash
apt install modemmanager
```

**Problem**: `Failed to list modems: Permission denied`
**Solution**: Run as root or add user to dialout group:
```bash
usermod -a -G dialout $USER
```

**Problem**: `API returned error: 401 Unauthorized`
**Solution**: Check SMS_API_KEY environment variable is set correctly

### Performance Issues

**Problem**: High CPU usage
**Solution**: Increase check_interval_secs in config:
```rust
check_interval_secs: 10, // Instead of 5
```

**Problem**: Slow modem checks
**Solution**: This is expected - sequential processing is slower but safer. Can be parallelized later if needed.

## Success Checklist

- [ ] Project builds without errors
- [ ] Can list all modems on Orange Pi
- [ ] Can read ICCID from each modem
- [ ] Can detect new SMS messages
- [ ] Can upload messages to API successfully
- [ ] Can upload phone status to API successfully
- [ ] Service starts automatically on boot
- [ ] Service runs for 24+ hours without crashes
- [ ] Memory usage stays under 200MB
- [ ] No segmentation faults or panics in logs

## Next Steps After Success

1. **Add SMS sending** - Implement `send_sms()` in modem_manager
2. **Add D-Bus native support** - Replace mmcli with zbus for better performance
3. **Add parallel processing** - Use tokio::spawn for concurrent modem checks
4. **Add metrics** - Export Prometheus metrics for monitoring
5. **Add health checks** - HTTP endpoint for readiness/liveness probes

## Estimated Timeline

- **Phase 1-3**: 1 hour (setup + types)
- **Phase 4**: 3 hours (ModemManager)
- **Phase 5**: 2 hours (API client)
- **Phase 6**: 2 hours (main loop)
- **Phase 7**: 2 hours (testing)
- **Phase 8**: 1 hour (NixOS)

**Total: 11 hours (~1.5 days)**

With breaks and debugging: **2-3 days** to a fully working system.

## Support

If you get stuck:
1. Check Rust compiler errors carefully - they're usually very helpful
2. Use `cargo clippy` to catch common mistakes
3. Add `#[derive(Debug)]` to types and print with `{:?}` for debugging
4. Use `RUST_LOG=debug` for verbose logging

Good luck! 🚀
