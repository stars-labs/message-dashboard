mod types;
mod modem_manager;
mod api_client;
mod sync_manager;
mod retry_manager;
mod sms_sender;

use anyhow::Result;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time;
use tracing::{info, warn, error};
use crate::types::*;
use crate::modem_manager::ModemManager;
use crate::api_client::ApiClient;
use crate::sync_manager::SyncManager;
use crate::retry_manager::RetryManager;
use crate::sms_sender::SmsSender;

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
    let modem_manager = ModemManager::new();
    let api_client = ApiClient::new(config.clone());

    // Initialize SMS sender
    let mut sms_sender = SmsSender::new(api_client.clone());

    // Initialize sync manager with unique session ID
    let session_id = format!("rust-daemon-{}", uuid::Uuid::new_v4());
    let mut sync_manager = SyncManager::new(session_id, 300); // Full sync every 5 minutes

    // Initialize retry manager for network resilience
    let mut retry_manager = RetryManager::new(3, 1000); // 3 retries, 1s base delay
    
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
        
        // Process modems concurrently in batches
        let batch_size = 20; // Process 20 modems at a time
        // Clone the HashMap entries to avoid borrow issues
        let modem_vec: Vec<(String, String)> = valid_modems.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        
        let mut all_messages = Vec::new();
        
        for batch in modem_vec.chunks(batch_size) {
            // Process this batch concurrently using tokio::spawn
            let mut join_handles = Vec::new();
            for (modem_id, iccid) in batch {
                let modem_id = modem_id.clone();
                let iccid = iccid.clone();
                let mm = modem_manager.clone();
                
                let handle = tokio::spawn(async move {
                    mm.get_new_messages(&modem_id, &iccid).await
                });
                join_handles.push(handle);
            }
            
            // Collect results
            for handle in join_handles {
                match handle.await {
                    Ok(Ok(messages)) => {
                        if !messages.is_empty() {
                            all_messages.extend(messages);
                        }
                    }
                    Ok(Err(e)) => {
                        warn!("⚠️  Failed to check modem: {}", e);
                    }
                    Err(e) => {
                        error!("❌ Task panicked: {}", e);
                    }
                }
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

            // Gather device data in normalized format
            let mut modems = Vec::new();
            let mut sims = Vec::new();

            for (modem_id, iccid) in &valid_modems {
                // Gather modem hardware details
                let (imei, manufacturer, model, firmware, hardware) =
                    modem_manager.get_device_details(modem_id)
                        .await
                        .unwrap_or_else(|_| (
                            format!("MODEM_{}", modem_id),
                            None,
                            None,
                            None,
                            None
                        ));

                let signal = modem_manager.get_signal_quality(modem_id)
                    .await
                    .unwrap_or_default();

                // Create Modem record
                modems.push(Modem {
                    equipment_id: imei.clone(),
                    manufacturer,
                    model,
                    firmware_revision: firmware,
                    hardware_revision: hardware,
                    status: "connected".to_string(),
                    signal: Some(signal.percent),
                    rssi: Some(signal.rssi),
                    rsrq: None,
                    rsrp: None,
                    snr: None,
                    modem_index: Some(modem_id.parse().unwrap_or(0)),
                    usb_port: None,
                    connection_status: Some("registered".to_string()),
                    network_type: None,
                    access_tech: None,
                });

                // Gather SIM data
                let phone_number = modem_manager.get_phone_number(modem_id)
                    .await
                    .ok()
                    .flatten();

                let operator = modem_manager.get_operator(modem_id)
                    .await
                    .ok()
                    .flatten();

                // Create SIM record
                sims.push(Sim {
                    iccid: iccid.clone(),
                    phone_number,
                    current_modem_id: Some(imei),
                    operator_name: operator,
                    operator_id: None,
                    status: "active".to_string(),
                    sim_index: None,
                });
            }

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
