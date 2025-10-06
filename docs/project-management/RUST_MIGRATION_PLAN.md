# Rust SMS Daemon Migration Plan

## Executive Summary

Migrate the Zig SMS daemon to Rust to eliminate memory corruption bugs while maintaining the same functionality. The Rust version will be **simpler, safer, and easier to maintain** with guaranteed memory safety.

## Current Architecture Analysis

### Zig Implementation (~2,500 LOC across 23 files)
- **Core Components**: ModemManager (77KB), Worker Pool (16KB), Main loop (25KB)
- **Concurrency**: 8 worker threads with lock-free queues
- **D-Bus**: Custom busctl wrapper + mmcli fallback
- **API**: HTTP client with JSON serialization
- **Key Issues**: Multiple memory corruption bugs, complex concurrency

### What We Need to Keep
1. **ModemManager D-Bus interface** - Query modems via D-Bus/mmcli
2. **SMS operations** - List, read, delete, send SMS
3. **Device status** - ICCID, signal strength, operator info
4. **API client** - Upload phone data and messages to backend
5. **Main loop** - Periodic polling of 87 modems

## Rust Implementation Plan

### Phase 1: Project Setup (30 minutes)

#### 1.1 Create Cargo Project
```bash
cd /home/freeman.xiong/Documents/github/hecoinfo/message-dashboard
cargo new --bin orange-pi-daemon-rust
cd orange-pi-daemon-rust
```

#### 1.2 Core Dependencies (Cargo.toml)
```toml
[package]
name = "orange-pi-daemon-rust"
version = "1.0.0"
edition = "2021"

[dependencies]
# Async runtime - single-threaded to keep it simple
tokio = { version = "1", features = ["rt", "time", "macros", "process"] }

# HTTP client for API calls
reqwest = { version = "0.11", features = ["json"] }

# JSON serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# Error handling
anyhow = "1"
thiserror = "1"

# D-Bus (optional - start with mmcli subprocess)
# zbus = "3"  # Uncomment later for native D-Bus

# Systemd integration
sd-notify = "0.4"
```

### Phase 2: Data Structures (1 hour)

#### 2.1 Core Types (`src/types.rs`)
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub api_url: String,
    pub api_key: String,
    pub check_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub phone_iccid: String,
    pub phone_number: String,
    pub content: String,
    pub timestamp: String,
    pub direction: String, // "received" or "sent"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phone {
    pub id: String,         // Equipment ID (IMEI)
    pub iccid: String,
    pub phone_number: Option<String>,
    pub signal_percent: i32,
    pub operator_name: Option<String>,
    pub status: String,     // "connected", "disconnected"
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware: Option<String>,
    pub hardware: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SignalData {
    pub percent: i32,
    pub rssi: i32,
}

#[derive(Debug)]
pub struct PendingSms {
    pub id: i64,
    pub recipient: String,
    pub message: String,
    pub phone_iccid: String,
}
```

### Phase 3: ModemManager Interface (3-4 hours)

#### 3.1 Simple mmcli Wrapper (`src/modem_manager.rs`)
```rust
use anyhow::{Context, Result};
use std::process::Command;
use crate::types::*;

pub struct ModemManager;

impl ModemManager {
    pub fn new() -> Self {
        Self
    }
    
    /// List all modem IDs
    pub async fn list_modems(&self) -> Result<Vec<String>> {
        let output = Command::new("mmcli")
            .arg("-L")
            .output()
            .context("Failed to list modems")?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut modems = Vec::new();
        
        // Parse: /org/freedesktop/ModemManager1/Modem/123
        for line in stdout.lines() {
            if let Some(modem_id) = Self::extract_modem_id(line) {
                modems.push(modem_id);
            }
        }
        
        Ok(modems)
    }
    
    /// Get ICCID for a modem
    pub async fn get_iccid(&self, modem_id: &str) -> Result<Option<String>> {
        // First get SIM path
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Extract SIM path: sim: /org/freedesktop/ModemManager1/SIM/123
        let sim_path = stdout
            .lines()
            .find(|l| l.trim().starts_with("sim:"))
            .and_then(|l| l.split("/SIM/").nth(1))
            .and_then(|s| s.trim().split_whitespace().next())?;
        
        // Query SIM for ICCID
        let sim_output = Command::new("mmcli")
            .arg("-i")
            .arg(sim_path)
            .output()?;
        
        let sim_stdout = String::from_utf8_lossy(&sim_output.stdout);
        
        // Extract ICCID: iccid: 1234567890
        let iccid = sim_stdout
            .lines()
            .find(|l| l.contains("iccid:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string());
        
        Ok(iccid)
    }
    
    /// Get phone number
    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<String>> {
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Extract: own: +1234567890
        let number = stdout
            .lines()
            .find(|l| l.contains("own:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string());
        
        Ok(number)
    }
    
    /// Get signal quality
    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Parse: signal quality: 75% (recent)
        let percent = stdout
            .lines()
            .find(|l| l.contains("signal quality:"))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|s| s.trim().split('%').next())
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or(0);
        
        Ok(SignalData {
            percent,
            rssi: (percent * 120 / 100) - 110, // Approximate RSSI
        })
    }
    
    /// Get new SMS messages
    pub async fn get_new_messages(&self, modem_id: &str) -> Result<Vec<Message>> {
        // List SMS
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .arg("--messaging-list-sms")
            .output()?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut messages = Vec::new();
        
        // Extract SMS IDs
        for line in stdout.lines() {
            if let Some(sms_id) = Self::extract_sms_id(line) {
                if let Ok(Some(msg)) = self.read_sms(modem_id, &sms_id).await {
                    messages.push(msg);
                }
            }
        }
        
        Ok(messages)
    }
    
    /// Read a specific SMS
    async fn read_sms(&self, modem_id: &str, sms_id: &str) -> Result<Option<Message>> {
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .arg("--sms")
            .arg(sms_id)
            .output()?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Parse SMS fields
        let mut content = String::new();
        let mut number = String::new();
        let mut timestamp = String::new();
        
        for line in stdout.lines() {
            if line.contains("text:") {
                content = line.split(':').nth(1).unwrap_or("").trim().to_string();
            } else if line.contains("number:") {
                number = line.split(':').nth(1).unwrap_or("").trim().to_string();
            } else if line.contains("timestamp:") {
                timestamp = line.split(':').nth(1).unwrap_or("").trim().to_string();
            }
        }
        
        if content.is_empty() {
            return Ok(None);
        }
        
        // Get ICCID for this modem
        let iccid = self.get_iccid(modem_id).await?.unwrap_or_default();
        
        Ok(Some(Message {
            phone_iccid: iccid,
            phone_number: number,
            content,
            timestamp,
            direction: "received".to_string(),
        }))
    }
    
    /// Delete SMS after processing
    pub async fn delete_sms(&self, modem_id: &str, sms_id: &str) -> Result<()> {
        Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .arg("--messaging-delete-sms")
            .arg(sms_id)
            .output()?;
        
        Ok(())
    }
    
    /// Get device details (IMEI, manufacturer, model, etc.)
    pub async fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let mut imei = String::new();
        let mut manufacturer = None;
        let mut model = None;
        let mut firmware = None;
        let mut hardware = None;
        
        for line in stdout.lines() {
            let line = line.trim();
            if line.contains("equipment id:") {
                imei = line.split(':').nth(1).unwrap_or("").trim().to_string();
            } else if line.contains("manufacturer:") {
                manufacturer = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            } else if line.contains("model:") {
                model = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            } else if line.contains("firmware revision:") || line.contains("revision:") {
                firmware = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            }
        }
        
        Ok((imei, manufacturer, model, firmware, hardware))
    }
    
    /// Get operator name
    pub async fn get_operator(&self, modem_id: &str) -> Result<Option<String>> {
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let operator = stdout
            .lines()
            .find(|l| l.contains("operator name:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string());
        
        Ok(operator)
    }
    
    // Helper functions
    fn extract_modem_id(line: &str) -> Option<String> {
        line.split("/Modem/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .map(|s| s.to_string())
    }
    
    fn extract_sms_id(line: &str) -> Option<String> {
        line.split("/SMS/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .map(|s| s.to_string())
    }
}
```

### Phase 4: API Client (2 hours)

#### 4.1 HTTP Client (`src/api_client.rs`)
```rust
use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::json;
use crate::types::*;

pub struct ApiClient {
    client: Client,
    config: Config,
}

impl ApiClient {
    pub fn new(config: Config) -> Self {
        Self {
            client: Client::new(),
            config,
        }
    }
    
    /// Upload phone status data
    pub async fn upload_phones(&self, phones: &[Phone]) -> Result<()> {
        let url = format!("{}/api/control/phones", self.config.api_url);
        
        let response = self.client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .json(&json!({ "phones": phones }))
            .send()
            .await
            .context("Failed to send phone data")?;
        
        if !response.status().is_success() {
            anyhow::bail!("API returned error: {}", response.status());
        }
        
        tracing::info!("✅ Uploaded {} phone records", phones.len());
        Ok(())
    }
    
    /// Upload messages
    pub async fn upload_messages(&self, messages: &[Message]) -> Result<()> {
        let url = format!("{}/api/control/messages", self.config.api_url);
        
        for message in messages {
            let response = self.client
                .post(&url)
                .header("x-api-key", &self.config.api_key)
                .json(message)
                .send()
                .await
                .context("Failed to upload message")?;
            
            if !response.status().is_success() {
                tracing::warn!("Failed to upload message: {}", response.status());
                continue;
            }
            
            tracing::info!("✅ Uploaded message from {}", message.phone_number);
        }
        
        Ok(())
    }
    
    /// Get pending SMS to send
    pub async fn get_pending_sms(&self) -> Result<Vec<PendingSms>> {
        let url = format!("{}/api/control/pending-sms", self.config.api_url);
        
        let response = self.client
            .get(&url)
            .header("x-api-key", &self.config.api_key)
            .send()
            .await
            .context("Failed to get pending SMS")?;
        
        if !response.status().is_success() {
            anyhow::bail!("API returned error: {}", response.status());
        }
        
        #[derive(Deserialize)]
        struct PendingResponse {
            pending_messages: Vec<PendingSms>,
        }
        
        let data: PendingResponse = response.json().await?;
        Ok(data.pending_messages)
    }
}
```

### Phase 5: Main Loop (2 hours)

#### 5.1 Simple Event Loop (`src/main.rs`)
```rust
mod types;
mod modem_manager;
mod api_client;

use anyhow::Result;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time;
use tracing::{info, warn, error};
use crate::types::*;
use crate::modem_manager::ModemManager;
use crate::api_client::ApiClient;

#[tokio::main(flavor = "current_thread")] // Single-threaded for simplicity
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter("orange_pi_daemon_rust=info")
        .init();
    
    // Load configuration
    let config = Config {
        api_url: std::env::var("SMS_API_URL").unwrap_or_else(|_| "http://localhost:8787".to_string()),
        api_key: std::env::var("SMS_API_KEY").expect("SMS_API_KEY must be set"),
        check_interval_secs: 5,
    };
    
    info!("🚀 Starting Rust SMS Daemon");
    info!("📡 API URL: {}", config.api_url);
    
    // Initialize components
    let modem_manager = ModemManager::new();
    let api_client = ApiClient::new(config.clone());
    
    // Cache of valid modems (those with SIM cards)
    let mut valid_modems: HashMap<String, String> = HashMap::new(); // modem_id -> iccid
    
    // Notify systemd
    let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Ready]);
    info!("🔔 Notified systemd - daemon ready");
    
    // Build initial modem cache
    info!("🔄 Building modem cache...");
    match modem_manager.list_modems().await {
        Ok(modems) => {
            for modem_id in modems {
                if let Ok(Some(iccid)) = modem_manager.get_iccid(&modem_id).await {
                    valid_modems.insert(modem_id.clone(), iccid);
                    info!("✅ Cached modem {} with ICCID", modem_id);
                }
            }
        }
        Err(e) => error!("Failed to list modems: {}", e),
    }
    
    info!("🚀 Starting main loop with {} modems", valid_modems.len());
    
    let mut cycle = 0u64;
    let mut last_sync = std::time::Instant::now();
    let sync_interval = Duration::from_secs(10);
    
    // Main event loop
    loop {
        cycle += 1;
        let cycle_start = std::time::Instant::now();
        
        // Check each modem for new messages
        let mut all_messages = Vec::new();
        for (modem_id, _iccid) in &valid_modems {
            match modem_manager.get_new_messages(modem_id).await {
                Ok(messages) => {
                    if !messages.is_empty() {
                        info!("📨 Found {} messages from modem {}", messages.len(), modem_id);
                        all_messages.extend(messages);
                    }
                }
                Err(e) => {
                    warn!("Failed to check modem {}: {}", modem_id, e);
                }
            }
        }
        
        // Upload messages if any found
        if !all_messages.is_empty() {
            if let Err(e) = api_client.upload_messages(&all_messages).await {
                error!("Failed to upload messages: {}", e);
            }
        }
        
        // Periodic device status sync
        if last_sync.elapsed() > sync_interval {
            info!("📤 Syncing device status to API");
            
            let mut phones = Vec::new();
            for (modem_id, iccid) in &valid_modems {
                // Gather device data
                let (imei, manufacturer, model, firmware, hardware) = 
                    modem_manager.get_device_details(modem_id).await.unwrap_or_default();
                
                let phone_number = modem_manager.get_phone_number(modem_id).await.ok().flatten();
                let signal = modem_manager.get_signal_quality(modem_id).await.unwrap_or(SignalData { percent: 0, rssi: -110 });
                let operator = modem_manager.get_operator(modem_id).await.ok().flatten();
                
                phones.push(Phone {
                    id: imei,
                    iccid: iccid.clone(),
                    phone_number,
                    signal_percent: signal.percent,
                    operator_name: operator,
                    status: "connected".to_string(),
                    manufacturer,
                    model,
                    firmware,
                    hardware,
                });
            }
            
            if let Err(e) = api_client.upload_phones(&phones).await {
                error!("Failed to upload phone data: {}", e);
            }
            
            last_sync = std::time::Instant::now();
        }
        
        // Refresh modem cache every 5 minutes
        if cycle % 60 == 0 {
            info!("🔄 Refreshing modem cache");
            valid_modems.clear();
            
            if let Ok(modems) = modem_manager.list_modems().await {
                for modem_id in modems {
                    if let Ok(Some(iccid)) = modem_manager.get_iccid(&modem_id).await {
                        valid_modems.insert(modem_id, iccid);
                    }
                }
            }
            
            info!("🔄 Cache refreshed: {} modems", valid_modems.len());
        }
        
        // Log progress
        if cycle % 10 == 0 {
            let elapsed = cycle_start.elapsed();
            info!("🔍 Cycle {}: checked {} modems in {:?}", cycle, valid_modems.len(), elapsed);
        }
        
        // Sleep until next cycle
        time::sleep(Duration::from_secs(config.check_interval_secs)).await;
    }
}
```

### Phase 6: NixOS Integration (1 hour)

#### 6.1 Update flake.nix
```nix
# In nixos-config/orange-pi/default.nix or similar
{
  environment.systemPackages = with pkgs; [
    # ... existing packages
    (pkgs.rustPlatform.buildRustPackage rec {
      pname = "orange-pi-daemon-rust";
      version = "1.0.0";
      src = ../../orange-pi-daemon-rust;
      
      cargoLock = {
        lockFile = ../../orange-pi-daemon-rust/Cargo.lock;
      };
      
      nativeBuildInputs = [ pkg-config ];
      buildInputs = [ openssl ];
    })
  ];
}
```

#### 6.2 Update systemd service
```nix
systemd.services.sms-daemon = {
  description = "SMS Dashboard Daemon (Rust)";
  wantedBy = [ "multi-user.target" ];
  after = [ "network.target" "ModemManager.service" ];
  
  serviceConfig = {
    Type = "notify";
    ExecStart = "${pkgs.orange-pi-daemon-rust}/bin/orange-pi-daemon-rust";
    Restart = "always";
    RestartSec = "10s";
    
    Environment = [
      "SMS_API_URL=https://sexy.qzz.io"
      "SMS_API_KEY=your-api-key"
      "RUST_LOG=info"
    ];
  };
};
```

## Implementation Timeline

| Phase | Task | Time | Priority |
|-------|------|------|----------|
| 1 | Project setup + dependencies | 30 min | HIGH |
| 2 | Data structures | 1 hour | HIGH |
| 3 | ModemManager interface | 3-4 hours | HIGH |
| 4 | API client | 2 hours | HIGH |
| 5 | Main loop | 2 hours | HIGH |
| 6 | Testing on Orange Pi | 2 hours | HIGH |
| 7 | NixOS integration | 1 hour | MEDIUM |
| 8 | D-Bus native (optional) | 4 hours | LOW |

**Total: 1-2 days for working prototype**

## Key Advantages of Rust Version

### Memory Safety
- ✅ **No segfaults** - Rust compiler guarantees memory safety
- ✅ **No data races** - Ownership system prevents concurrent access bugs
- ✅ **No use-after-free** - Borrowchecker enforces lifetime rules

### Simplicity
- ✅ **Single-threaded** - Tokio async for I/O concurrency without threads
- ✅ **~500 LOC** - vs 2,500 LOC in Zig (5x reduction)
- ✅ **No lock-free queues** - Simple sequential processing

### Maintainability
- ✅ **Type safety** - Compiler catches errors at build time
- ✅ **Great tooling** - cargo, clippy, rust-analyzer
- ✅ **Rich ecosystem** - Well-tested crates for HTTP, async, etc.

## Migration Strategy

### Week 1: Parallel Development
- Keep Zig daemon running in production
- Develop Rust version in parallel
- Test Rust version with subset of modems

### Week 2: Gradual Rollout
- Deploy Rust version alongside Zig
- Monitor for 24 hours
- Compare data accuracy and stability

### Week 3: Full Cutover
- Switch to Rust daemon completely
- Remove Zig code
- Document lessons learned

## Testing Checklist

- [ ] Can list all 87 modems
- [ ] Can read ICCID from each modem
- [ ] Can detect new SMS messages
- [ ] Can upload messages to API
- [ ] Can upload phone status to API
- [ ] Handles ModemManager restarts gracefully
- [ ] Handles API downtime gracefully
- [ ] Runs for 24+ hours without crashes
- [ ] Memory usage stays stable

## Fallback Plan

If Rust version has issues:
1. Keep running Zig daemon with 1 worker (no concurrency)
2. Debug Rust version offline
3. Fix issues and retry deployment

## Next Steps

1. **Review this plan** - Any missing requirements?
2. **Start Phase 1** - Create Cargo project
3. **Implement Phase 2-3** - Core types and ModemManager
4. **Test locally** - Verify mmcli parsing works
5. **Deploy to Orange Pi** - Test with real hardware

## Questions to Resolve

1. Should we use native D-Bus (zbus) or stick with mmcli subprocess?
   - **Recommendation**: Start with mmcli, add zbus later if needed
   
2. Do we need to send SMS or just receive?
   - **Current**: Just receive and upload
   - **Future**: API can queue SMS to send
   
3. Should we persist any state locally?
   - **Recommendation**: No - keep it stateless for simplicity
   
4. How should we handle modem disconnects/reconnects?
   - **Recommendation**: Just refresh cache every 5 minutes

## Success Criteria

1. ✅ **Zero segfaults** for 7 days continuous operation
2. ✅ **All messages captured** - compare with Zig version logs
3. ✅ **API uploads working** - verify data in dashboard
4. ✅ **Memory stable** - < 100MB RSS, no leaks
5. ✅ **Easy to debug** - clear logs, simple code

---

**Ready to start? Let me know and I'll help you implement Phase 1!**
