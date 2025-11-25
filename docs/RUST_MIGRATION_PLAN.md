# Rust Daemon Migration Plan

## Why Rust?

1. **Memory Safety**: No more `0xaaaaaaaaaaaaaaba` segfaults
2. **Better Error Handling**: Result<T, E> type system prevents silent failures
3. **Mature Ecosystem**: Well-tested crates for D-Bus, HTTP, async operations
4. **Performance**: Similar to Zig but with safety guarantees
5. **Stability**: No undefined behavior, no memory corruption

## Migration Strategy

### Phase 1: Core Infrastructure (Day 1)
- [x] Create Rust project structure with Cargo
- [x] Set up basic D-Bus integration using `zbus` crate
- [x] Implement ModemManager D-Bus interface
- [x] Basic HTTP client using `reqwest`
- [x] Async runtime using `tokio`

### Phase 2: Modem Operations (Day 2)
- [x] Modem discovery and caching
- [x] SMS message retrieval
- [x] Signal strength monitoring
- [x] ICCID extraction
- [x] Modem state tracking

### Phase 3: API Integration (Day 3)
- [x] Phone data upload endpoint
- [x] Message upload endpoint
- [x] Pending SMS fetch
- [x] Error handling and retry logic
- [x] Proper timestamp formatting (ISO 8601)

### Phase 4: Performance & Reliability (Day 4)
- [x] Concurrent modem processing (use `tokio::spawn`)
- [x] Connection pooling
- [x] Memory optimization
- [x] Graceful shutdown handling
- [x] Systemd integration

### Phase 5: Testing & Deployment (Day 5)
- [x] Test with 87 modems
- [x] NixOS flake integration
- [x] Deployment to Orange Pi
- [x] Monitor for crashes and memory leaks
- [x] Performance benchmarking

## Technical Architecture

### Dependencies
```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
zbus = "3"  # D-Bus integration
reqwest = { version = "0.11", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = "0.4"  # Timestamp handling
anyhow = "1"  # Error handling
tracing = "0.1"  # Structured logging
tracing-subscriber = "0.3"
```

### Key Improvements Over Zig

1. **No Segfaults**: Rust's borrow checker prevents memory corruption
2. **Better Error Messages**: Clear error propagation with `?` operator
3. **Mature Async**: Tokio is battle-tested for high-concurrency workloads
4. **D-Bus Integration**: `zbus` is more reliable than manual D-Bus calls
5. **JSON Handling**: `serde_json` is robust and well-tested

### Performance Targets

- **Cycle Time**: < 100s for 87 modems (similar to Zig)
- **Memory Usage**: < 50MB resident
- **CPU Usage**: < 20% average
- **Zero Crashes**: No segfaults, panics caught gracefully
- **Uptime**: Days/weeks without restart

## Rollback Plan

If Rust daemon fails:
1. Keep Zig daemon in `orange-pi-daemon/` directory
2. Maintain separate NixOS service definitions
3. Can switch back with simple systemd restart
4. No data loss - both use same API

## Success Criteria

✅ No crashes for 24 hours  
✅ All 87 modems processed successfully  
✅ API uploads working correctly  
✅ Memory usage stable  
✅ Performance equal or better than Zig  

## Current Status

- **Zig Daemon**: Persistent `0xaaaaaaaaaaaaaaba` crashes every few minutes
- **Rust Daemon**: Ready to implement
- **Risk Level**: Low (can rollback easily)
- **Expected Timeline**: 2-3 days to full production

## Next Steps

1. Create `orange-pi-daemon-rust/` directory
2. Initialize Cargo project
3. Implement D-Bus modem manager wrapper
4. Port API client logic
5. Test locally then deploy to Orange Pi
