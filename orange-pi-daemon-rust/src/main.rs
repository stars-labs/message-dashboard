mod types;
mod modem_manager;
mod api_client;
mod sync_manager;
mod retry_manager;
mod sms_sender;
mod dbus_client;
mod signal_cache;
mod worker_pool;

use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time;
use tracing::{info, warn, error};
use crate::types::*;
use crate::modem_manager::ModemManager;
use crate::api_client::ApiClient;
use crate::sync_manager::SyncManager;
use crate::retry_manager::RetryManager;
use crate::sms_sender::SmsSender;
use crate::worker_pool::{WorkerPool, WorkerPoolConfig};

#[tokio::main(flavor = "multi_thread", worker_threads = 4)] // Multi-threaded for concurrent modem processing
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "orange_pi_daemon_rust=info".to_string())
        )
        .init();
    
    // Load configuration
    let config = Config {
        api_url: std::env::var("SMS_API_URL")
            .unwrap_or_else(|_| "https://sexy.qzz.io".to_string()),
        api_key: std::env::var("SMS_API_KEY")
            .expect("SMS_API_KEY environment variable must be set"),
        check_interval_secs: std::env::var("CHECK_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30), // Changed from 5s to 30s to reduce load
    };

    info!("🚀 Starting Rust SMS Daemon v2.0.0 (Sync Manager Edition)");
    info!("📡 API URL: {}", config.api_url);
    info!("⏱️  Device sync interval: {}s", config.check_interval_secs);

    // Initialize components
    let modem_manager = Arc::new(ModemManager::new());
    let api_client = ApiClient::new(config.clone());

    // Initialize SMS sender
    let mut sms_sender = SmsSender::new(api_client.clone());

    // Initialize sync manager with unique session ID
    let session_id = format!("rust-daemon-{}", uuid::Uuid::new_v4());
    let mut sync_manager = SyncManager::new(session_id, 300); // Full sync every 5 minutes

    // Initialize retry manager for network resilience
    let mut retry_manager = RetryManager::new(3, 1000); // 3 retries, 1s base delay

    // Initialize worker pool for parallel modem processing
    let worker_config = WorkerPoolConfig {
        num_workers: 8,  // 8 parallel workers for optimal performance
        batch_size: 20,  // Process up to 20 modems per batch
        modem_timeout: Duration::from_secs(5),
    };
    let worker_pool = WorkerPool::new(worker_config, modem_manager.clone());
    info!("👷 Worker pool initialized with 8 parallel workers");
    
    // Cache of valid modems (those with SIM cards)
    let mut valid_modems: HashMap<String, String> = HashMap::new(); // modem_id -> iccid
    
    // Build initial modem cache
    info!("🔄 Building initial modem cache...");
    match modem_manager.list_modems().await {
        Ok(modems) => {
            info!("📋 Found {} modems, checking for SIM cards...", modems.len());
            for modem_id in modems {
                match modem_manager.get_iccid(&modem_id).await {
                    Ok(Some(iccid)) => {
                        valid_modems.insert(modem_id.clone(), iccid.clone());
                        info!("✅ Cached modem {} with ICCID {}", modem_id, iccid);
                    }
                    Ok(None) => {
                        warn!("⚠️  Modem {} has no SIM card", modem_id);
                    }
                    Err(e) => {
                        warn!("⚠️  Failed to get ICCID for modem {}: {}", modem_id, e);
                    }
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to list modems: {}", e);
            error!("💡 Make sure ModemManager is running: systemctl status ModemManager");
        }
    }
    
    if valid_modems.is_empty() {
        error!("❌ No modems with SIM cards found!");
        error!("💡 Check: mmcli -L");
        return Ok(());
    }
    
    // Notify systemd that we're ready
    let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Ready]);
    info!("🔔 Notified systemd - daemon is ready");
    
    info!("🚀 Starting main loop with {} modems", valid_modems.len());
    
    let mut cycle = 0u64;
    let mut last_sync = std::time::Instant::now();
    let sync_interval = Duration::from_secs(10);
    
    // Main event loop
    loop {
        cycle += 1;
        let cycle_start = std::time::Instant::now();
        
        // Process modems in parallel using worker pool
        let modem_ids: Vec<String> = valid_modems.keys().cloned().collect();

        let mut all_messages = Vec::new();
        let mut all_phones = Vec::new();
        let mut all_sims = Vec::new();

        // Process all modems in parallel with worker pool
        match worker_pool.process_modems(modem_ids.clone()).await {
            Ok(results) => {
                for result in results {
                    if let Some(error) = &result.error {
                        if error != "No SIM card" && error != "Timeout" {
                            warn!("⚠️  Modem {} error: {}", result.modem_id, error);
                        }
                    }

                    // Collect messages
                    if !result.messages.is_empty() {
                        all_messages.extend(result.messages);
                    }

                    // Collect phone data
                    if let Some(phone) = result.phone {
                        all_phones.push(phone);
                    }

                    // Collect SIM data
                    if let Some(sim) = result.sim {
                        all_sims.push(sim);
                    }
                }

                // Log worker pool statistics
                let stats = worker_pool.get_stats().await;
                if cycle % 10 == 0 {  // Log stats every 10 cycles
                    info!("📊 Worker pool stats: {} modems, {:.1}% success, avg {:.2}s/modem",
                        stats.total_modems,
                        stats.success_rate(),
                        stats.avg_time_per_modem.as_secs_f64()
                    );
                }
            }
            Err(e) => {
                error!("❌ Worker pool failed: {}", e);
            }
        }
        
        // Upload messages if any found
        if !all_messages.is_empty() {
            info!("📤 Uploading {} messages to API", all_messages.len());
            if let Err(e) = api_client.upload_messages(&all_messages).await {
                error!("❌ Failed to upload messages: {}", e);
            }
        }

        // Check and send pending SMS every 5 cycles (every 5 * check_interval_secs seconds)
        if cycle % 5 == 0 {
            // Update SMS sender's modem cache with our valid modems (ICCID -> modem_id mapping)
            let iccid_to_modem: HashMap<String, String> = valid_modems
                .iter()
                .map(|(modem_id, iccid)| (iccid.clone(), modem_id.clone()))
                .collect();
            sms_sender.update_modem_cache(iccid_to_modem);

            // Process pending SMS messages
            match sms_sender.process_pending_sms().await {
                Ok(_) => {}
                Err(e) => {
                    warn!("⚠️  Failed to process pending SMS: {}", e);
                }
            }
        }

        // Periodic device status sync (respecting sync manager timing)
        if last_sync.elapsed() > sync_interval && sync_manager.can_sync_now() {
            let sync_mode = sync_manager.get_sync_mode();

            info!("🔄 Syncing device status to API (mode: {})", sync_mode.as_str());

            // Use data already collected by worker pool for efficiency
            let modems: Vec<Modem> = all_phones.iter().map(|phone| {
                Modem {
                    equipment_id: phone.imei.clone().unwrap_or_else(|| format!("MODEM_{}", phone.iccid)),
                    manufacturer: phone.manufacturer.clone(),
                    model: phone.model.clone(),
                    firmware_revision: phone.firmware_revision.clone(),
                    hardware_revision: phone.hardware_revision.clone(),
                    status: phone.status.clone(),
                    signal: phone.signal,
                    rssi: phone.rssi,
                    rsrq: phone.rsrq,
                    rsrp: phone.rsrp,
                    snr: phone.snr,
                    modem_index: phone.modem_index,
                    usb_port: phone.usb_port.as_ref().and_then(|p| p.parse().ok()),
                    connection_status: Some("registered".to_string()),
                    network_type: None,
                    access_tech: phone.access_tech.clone(),
                }
            }).collect();

            let sims = all_sims.clone();

            // Validate before uploading
            if let Err(e) = sync_manager.validate_sync_data(&modems, &sims) {
                error!("❌ Data validation failed: {}", e);
            } else {
                // Upload with retry logic
                retry_manager.reset();

                let upload_result = retry_manager.execute_with_retry(|| {
                    let api_client = &api_client;
                    let modems = &modems;
                    let sims = &sims;
                    let session_id = sync_manager.session_id();
                    async move {
                        api_client.upload_devices(modems, sims, sync_mode, session_id).await
                    }
                }).await;

                match upload_result {
                    Ok(_) => {
                        sync_manager.record_success(sync_mode);
                    }
                    Err(e) => {
                        // Convert anyhow::Error to a type that implements std::error::Error
                        let error_msg = format!("{}", e);
                        let io_error = std::io::Error::new(std::io::ErrorKind::Other, error_msg.clone());
                        sync_manager.record_failure(sync_mode, &io_error);
                        error!("❌ Failed to upload device data after retries: {}", error_msg);
                    }
                }
            }

            last_sync = std::time::Instant::now();
        }
        
        // Refresh modem cache every 5 minutes (60 cycles at 5s interval)
        if cycle % 60 == 0 {
            info!("🔄 Refreshing modem cache (every 5 minutes)");
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
        
        // Log progress every 10 cycles
        if cycle % 10 == 0 {
            let elapsed = cycle_start.elapsed();
            info!("🔍 Cycle {}: checked {} modems in {:?}", 
                  cycle, valid_modems.len(), elapsed);
        }
        
        // Sleep until next cycle
        time::sleep(Duration::from_secs(config.check_interval_secs)).await;
    }
}
