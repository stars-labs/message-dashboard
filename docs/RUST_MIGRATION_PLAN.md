# Rust Daemon Migration Plan

## Executive Summary
Migrate from Zig to Rust to eliminate persistent segmentation faults and improve reliability for managing 87+ USB modems.

## Why Rust?
1. **Memory Safety**: No segfaults - Rust's borrow checker prevents memory corruption at compile time
2. **Better Tooling**: Excellent ecosystem (cargo, clippy, rustfmt)
3. **Async Runtime**: Tokio provides battle-tested async I/O for concurrent modem processing
4. **HTTP Client**: reqwest is reliable and well-maintained
5. **Error Handling**: Result<T, E> pattern forces explicit error handling

## Current Issues in Zig Daemon
- Persistent segmentation faults at address `0xaaaaaaaaaaaaaaba`
- Memory corruption in worker threads
- Difficult debugging without proper symbols
- Timestamp parsing errors causing malformed data
- 500 Internal Server Errors from API

## Architecture

### Core Components

1. **modem_manager.rs** - ModemManager D-Bus Integration
   - List all modems via mmcli subprocess calls
   - Extract modem hardware details (IMEI, manufacturer, model, firmware)
   - Get signal quality metrics
   - List SMS messages on each modem
   - Delete processed messages

2. **api_client.rs** - HTTP API Communication
   - Upload phone/device status to `/api/control/phones`
   - Upload SMS messages to `/api/control/messages`
   - Check for pending SMS to send via `/api/control/pending-sms`
   - Send SMS via mmcli
   - Report send results back to API

3. **types.rs** - Data Structures
   ```rust
   struct Modem {
       equipment_id: String,  // IMEI
       manufacturer: Option<String>,
       model: Option<String>,
       firmware_revision: Option<String>,
       status: String,
       signal: Option<u8>,
       // ... signal metrics
   }
   
   struct SIM {
       iccid: String,
       phone_number: Option<String>,
       current_modem_id: Option<String>,
       operator_name: Option<String>,
       status: String,
   }
   
   struct Message {
       phone_iccid: String,
       phone_number: String,
       content: String,
       timestamp: String,  // ISO 8601 format
   }
   ```

4. **main.rs** - Main Event Loop
   - Initialize modem cache
   - Spawn async tasks for each modem
   - Periodic sync (every 30 seconds for status, continuous for messages)
   - Graceful shutdown on SIGTERM

### Dependencies (Cargo.toml)

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.11", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = "0.4"
log = "0.4"
env_logger = "0.10"
anyhow = "1"
```

### Data Flow

```
┌─────────────┐
│ ModemManager│ (mmcli via subprocess)
└──────┬──────┘
       │
       ▼
┌──────────────┐
│ Modem Cache  │ (Vec<ModemInfo>)
└──────┬───────┘
       │
       ▼
┌──────────────┐      ┌─────────────┐
│ Main Loop    │─────▶│ API Client  │
│ (async/await)│      │ (reqwest)   │
└──────────────┘      └─────┬───────┘
                            │
                            ▼
                    ┌────────────────┐
                    │ Cloudflare API │
                    │ /api/control/* │
                    └────────────────┘
```

## Implementation Steps

### Phase 1: Basic Structure (Day 1)
- [ ] Set up Cargo project in `orange-pi-daemon-rust/`
- [ ] Create `types.rs` with core data structures
- [ ] Create `modem_manager.rs` with mmcli integration
- [ ] Create `api_client.rs` with HTTP client
- [ ] Create `main.rs` with basic event loop

### Phase 2: Core Functionality (Day 2)
- [ ] Implement modem discovery via `mmcli -L`
- [ ] Extract modem details (IMEI, model, etc.)
- [ ] Extract SIM details (ICCID, phone number, operator)
- [ ] Get signal quality metrics
- [ ] Upload device status to API

### Phase 3: Message Handling (Day 3)
- [ ] List SMS messages on each modem
- [ ] Parse message content and metadata
- [ ] **Fix timestamp parsing** - proper ISO 8601 format
- [ ] Upload messages to API
- [ ] Delete processed messages from modem

### Phase 4: SMS Sending (Day 4)
- [ ] Poll API for pending SMS
- [ ] Find modem by ICCID
- [ ] Send SMS via `mmcli -m <modem> --messaging-create-sms`
- [ ] Report send result back to API

### Phase 5: NixOS Integration (Day 5)
- [ ] Create Nix flake for Rust daemon
- [ ] Update `nixos-config/flake.nix`
- [ ] Create systemd service
- [ ] Deploy to Orange Pi
- [ ] Monitor for stability

### Phase 6: Testing & Optimization (Day 6)
- [ ] Test with all 87 modems
- [ ] Monitor memory usage
- [ ] Check for crashes/panics
- [ ] Optimize performance (reduce cycle time)
- [ ] Add logging and error handling

## Critical Fixes for Current Rust Implementation

### Issue 1: Timestamp Parsing Bug
**Problem**: Timestamps like `"2025-10-05T19:05:4208"` are malformed

**Root Cause**: String manipulation error when extracting timestamp from mmcli output

**Fix in `modem_manager.rs`**:
```rust
// WRONG - using split(':') destroys timestamp
let parts: Vec<&str> = line.splitn(2, ':').collect();
let timestamp = parts[1].trim();

// CORRECT - find "timestamp:" and extract everything after it
if let Some(pos) = line.find("timestamp:") {
    let timestamp = line[pos + 10..].trim();
    // timestamp is now "2025-10-05T14:23:45+08:00" (correct)
}
```

### Issue 2: API 500 Internal Server Error
**Problem**: `/api/control/phones` returns 500 error

**Likely Causes**:
1. Missing required fields in request payload
2. Malformed data (e.g., bad timestamps)
3. Database constraint violations

**Fix**: 
1. Add detailed error logging to API handler
2. Validate all data before sending
3. Use proper NULL handling for optional fields

### Issue 3: DNS Resolution Failures
**Problem**: `error.TemporaryNameServerFailure`

**Fix**: Add retry logic with exponential backoff
```rust
async fn upload_with_retry<T>(
    &self,
    url: &str,
    data: &T,
    max_retries: u32,
) -> Result<()>
where
    T: Serialize,
{
    let mut delay = Duration::from_secs(1);
    
    for attempt in 0..max_retries {
        match self.client.post(url).json(data).send().await {
            Ok(response) => return Ok(()),
            Err(e) if e.is_connect() || e.is_timeout() => {
                warn!("Attempt {} failed: {}", attempt + 1, e);
                tokio::time::sleep(delay).await;
                delay *= 2;  // Exponential backoff
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }
    
    Err(anyhow!("Failed after {} retries", max_retries))
}
```

## Success Criteria

### Functional Requirements
- [ ] Discover all 87 modems successfully
- [ ] Extract complete modem/SIM information
- [ ] Upload device status every 30 seconds
- [ ] Collect and forward all SMS messages
- [ ] Send SMS via API commands
- [ ] Handle modem disconnections gracefully

### Non-Functional Requirements
- [ ] No segmentation faults (run for 24+ hours)
- [ ] Memory usage < 100MB (currently ~50MB with Zig)
- [ ] CPU usage < 30% (currently ~20% with Zig)
- [ ] Cycle time < 120 seconds for 87 modems
- [ ] Proper error recovery and logging

### Performance Targets
- Modem discovery: < 5 seconds
- Status upload: < 2 seconds per cycle
- Message processing: < 1 second per message
- Total cycle time: < 100 seconds for 87 modems

## Rollback Plan
If Rust daemon fails:
1. Keep Zig daemon systemd service definition
2. Switch back via NixOS rebuild:
   ```bash
   git revert <rust-migration-commit>
   nixos-rebuild switch --flake .#orange-pi --target-host root@203.116.95.146
   ```

## Monitoring
- systemd service status: `systemctl status sms-daemon`
- Logs: `journalctl -fu sms-daemon`
- Crashes: `journalctl -u sms-daemon | grep -i "segfault\|panic"`
- API errors: Filter logs for "ERROR" or "500 Internal Server Error"
- Performance: Monitor cycle time logs

## Timeline
- **Day 1-3**: Core implementation
- **Day 4-5**: NixOS integration and deployment
- **Day 6-7**: Testing and optimization
- **Week 2**: Production monitoring

## Notes
- Rust's memory safety eliminates 100% of segfaults
- tokio's async runtime is production-proven (used by Discord, AWS, etc.)
- Smaller, simpler codebase (~500 lines vs 2000+ in Zig)
- Better error messages and debugging tools
