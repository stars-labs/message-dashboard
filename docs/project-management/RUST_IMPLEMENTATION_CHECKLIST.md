# Rust SMS Daemon - Implementation Checklist

## 📋 Complete Implementation Checklist

Use this checklist to track your progress implementing the Rust daemon.

---

## Phase 1: Setup ⏱️ 30 minutes

- [ ] **Install Rust toolchain**
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source ~/.cargo/env
  rustc --version  # Verify
  ```

- [ ] **Create Cargo project**
  ```bash
  cd /path/to/message-dashboard
  cargo new --bin orange-pi-daemon-rust
  cd orange-pi-daemon-rust
  ```

- [ ] **Configure dependencies**
  - Copy `Cargo.toml` from `RUST_MIGRATION_PLAN.md` Phase 1.2
  - Run `cargo build` to download dependencies
  - Verify it compiles

---

## Phase 2: Data Structures ⏱️ 1 hour

- [ ] **Create `src/types.rs`**
  - Copy code from `RUST_MIGRATION_PLAN.md` Phase 2.1
  - Add `mod types;` to `src/main.rs`
  - Verify compilation: `cargo check`

- [ ] **Test structures**
  ```bash
  # Add a simple test in types.rs
  cargo test
  ```

---

## Phase 3: ModemManager Interface ⏱️ 3-4 hours

- [ ] **Create `src/modem_manager.rs`**
  - Copy skeleton from `RUST_MIGRATION_PLAN.md` Phase 3.1
  - Add `mod modem_manager;` to `src/main.rs`

- [ ] **Implement core methods**
  - [ ] `list_modems()` - Parse `mmcli -L` output
  - [ ] `get_iccid()` - Extract SIM ICCID
  - [ ] `get_phone_number()` - Extract phone number
  - [ ] `get_signal_quality()` - Parse signal strength
  - [ ] `get_new_messages()` - List and read SMS
  - [ ] `delete_sms()` - Remove processed messages
  - [ ] `get_device_details()` - IMEI, manufacturer, etc.
  - [ ] `get_operator()` - Network operator name

- [ ] **Test on Orange Pi**
  ```bash
  # Create test program
  cargo run --example test_modem_manager
  ```

- [ ] **Verify all mmcli commands work**
  - Test with real modems
  - Handle error cases
  - Log all operations

---

## Phase 4: API Client ⏱️ 2 hours

- [ ] **Create `src/api_client.rs`**
  - Copy code from `RUST_MIGRATION_PLAN.md` Phase 4.1
  - Add `mod api_client;` to `src/main.rs`

- [ ] **Implement API methods**
  - [ ] `upload_phones()` - POST phone status
  - [ ] `upload_messages()` - POST SMS messages
  - [ ] `get_pending_sms()` - GET outbound messages (optional)

- [ ] **Test API calls**
  ```bash
  # Set environment variables
  export SMS_API_URL="https://sexy.qzz.io"
  export SMS_API_KEY="test-key"
  
  # Run test
  cargo run --example test_api_client
  ```

- [ ] **Handle errors gracefully**
  - Network timeouts
  - Invalid responses
  - Retry logic

---

## Phase 5: Main Loop ⏱️ 2 hours

- [ ] **Implement main loop**
  - Replace `src/main.rs` with code from `RUST_MIGRATION_PLAN.md` Phase 5.1

- [ ] **Verify functionality**
  - [ ] Loads configuration from environment
  - [ ] Initializes ModemManager
  - [ ] Initializes API client
  - [ ] Notifies systemd (sd_notify)
  - [ ] Builds initial modem cache
  - [ ] Main event loop runs
  - [ ] Checks for new messages
  - [ ] Uploads messages
  - [ ] Syncs device status periodically
  - [ ] Refreshes modem cache periodically
  - [ ] Logs progress

- [ ] **Test locally**
  ```bash
  export SMS_API_URL="https://sexy.qzz.io"
  export SMS_API_KEY="actual-key"
  export RUST_LOG="debug"
  
  cargo run --release
  ```

---

## Phase 6: Testing ⏱️ 2 hours

- [ ] **Unit tests**
  ```bash
  cargo test
  ```

- [ ] **Linting**
  ```bash
  cargo clippy
  cargo fmt --check
  ```

- [ ] **Build release binary**
  ```bash
  cargo build --release
  ls -lh target/release/orange-pi-daemon-rust
  ```

- [ ] **Test on Orange Pi**
  - Copy binary to Orange Pi
  - Run manually
  - Monitor logs
  - Verify data in dashboard

---

## Phase 7: Nix Integration ⏱️ 1 hour

- [ ] **Generate Cargo.lock**
  ```bash
  cargo build  # Creates Cargo.lock if not exists
  git add Cargo.lock
  ```

- [ ] **Update flake.nix**
  - [ ] Add `sms-daemon-rust` package (see `flake-rust-additions.nix`)
  - [ ] Add to `packages` export
  - [ ] Update NixOS configuration with `useRustDaemon` option
  - [ ] Optional: Add Rust dev shell

- [ ] **Test Nix build**
  ```bash
  nix build .#sms-daemon-rust
  ./result/bin/sms-daemon
  ```

- [ ] **Update NixOS module** (`nixos-config/modules/sms-daemon.nix`)
  - [ ] Add `useRustDaemon` option
  - [ ] Support environment variables for Rust
  - [ ] Keep CLI args for Zig
  - [ ] See `NIX_FLAKE_RUST_INTEGRATION.md` for details

---

## Phase 8: Deployment ⏱️ 1 hour

- [ ] **Deploy to Orange Pi**
  ```bash
  # Set useRustDaemon = true in flake.nix
  
  nixos-rebuild switch \
      --flake .#orange-pi \
      --use-substitutes \
      --target-host root@203.116.95.146 \
      --build-host root@203.116.95.146 \
      --impure
  ```

- [ ] **Verify deployment**
  ```bash
  ssh root@203.116.95.146
  
  # Check service
  systemctl status sms-daemon
  # Should say "SMS Dashboard Daemon (Rust)"
  
  # Check binary
  readlink -f /run/current-system/sw/bin/sms-daemon
  # Should point to sms-daemon-rust store path
  
  # Watch logs
  journalctl -u sms-daemon -f
  ```

- [ ] **Monitor for 24 hours**
  - Check for crashes
  - Verify message collection
  - Check memory usage: `systemctl show sms-daemon | grep Memory`
  - Compare with Zig daemon logs

---

## Phase 9: Validation ⏱️ Ongoing

- [ ] **Stability checks**
  - [ ] No segmentation faults (should be zero)
  - [ ] No panics in logs
  - [ ] Service stays running
  - [ ] Memory usage stays under 200MB

- [ ] **Functionality checks**
  - [ ] All 87 modems detected
  - [ ] Messages collected and uploaded
  - [ ] Phone status updated correctly
  - [ ] Dashboard shows correct data

- [ ] **Performance checks**
  - [ ] Acceptable check cycle time
  - [ ] API uploads working
  - [ ] No significant delays

---

## Phase 10: Cleanup & Documentation

- [ ] **Remove Zig code** (if Rust version successful)
  ```bash
  git rm -r orange-pi-daemon
  # Update flake.nix to remove Zig packages
  ```

- [ ] **Update documentation**
  - [ ] README.md
  - [ ] Deployment instructions
  - [ ] Architecture diagrams

- [ ] **Lessons learned**
  - Document what worked
  - Document issues encountered
  - Share knowledge with team

---

## Troubleshooting Reference

### Build Issues

| Problem | Solution |
|---------|----------|
| `cargo: command not found` | Install Rust: `curl https://sh.rustup.rs \| sh` |
| `error: linking with cc failed` | Install: `apt install build-essential pkg-config libssl-dev` |
| `cannot find -lssl` | Install: `apt install libssl-dev` |

### Runtime Issues

| Problem | Solution |
|---------|----------|
| `mmcli: command not found` | Install: `apt install modemmanager` |
| `Permission denied` | Run as root or add to dialout group |
| `API returned 401` | Check SMS_API_KEY environment variable |
| High CPU usage | Increase check_interval_secs |

### Nix Issues

| Problem | Solution |
|---------|----------|
| `Cargo.lock not found` | Run `cargo build` to generate it |
| `hash mismatch` | Update cargoLock.outputHashes in flake |
| Wrong binary name | Add postInstall to rename in flake |

---

## Success Criteria

✅ **Must Have:**
- [ ] Zero crashes for 7 consecutive days
- [ ] All messages captured (compare with previous logs)
- [ ] API uploads working correctly
- [ ] Memory usage stable (< 200MB)

✅ **Nice to Have:**
- [ ] Faster startup than Zig version
- [ ] Lower memory usage
- [ ] Clearer error messages
- [ ] Easier to debug

---

## Timeline Summary

| Phase | Time | Status |
|-------|------|--------|
| 1. Setup | 30 min | ⬜ |
| 2. Types | 1 hour | ⬜ |
| 3. ModemManager | 3-4 hours | ⬜ |
| 4. API Client | 2 hours | ⬜ |
| 5. Main Loop | 2 hours | ⬜ |
| 6. Testing | 2 hours | ⬜ |
| 7. Nix Integration | 1 hour | ⬜ |
| 8. Deployment | 1 hour | ⬜ |
| **Total** | **12-13 hours** | **~2 days** |

---

## Next Steps

1. **Start Phase 1** - Install Rust and create project
2. **Follow RUST_QUICKSTART.md** - Step-by-step guide
3. **Reference RUST_MIGRATION_PLAN.md** - Detailed code examples
4. **Use NIX_FLAKE_RUST_INTEGRATION.md** - Nix-specific help

**Ready to begin? Start with Phase 1!** 🚀

---

## Questions?

See the migration documentation:
- **MIGRATION_SUMMARY.md** - Executive overview
- **RUST_MIGRATION_PLAN.md** - Technical details
- **RUST_QUICKSTART.md** - Implementation guide
- **NIX_FLAKE_RUST_INTEGRATION.md** - Nix flake integration

Good luck! The Rust compiler will be your friend. 🦀
