use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time;
use tracing::{debug, info, warn, error};

// Import from the library crate
use orange_pi_daemon_rust::types::*;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::sync_manager::SyncManager;
use orange_pi_daemon_rust::retry_manager::RetryManager;
use orange_pi_daemon_rust::sms_sender::SmsSender;
use orange_pi_daemon_rust::worker_pool::{WorkerPool, WorkerPoolConfig};
use orange_pi_daemon_rust::benchmark::PerformanceBenchmark;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)] // Multi-threaded for concurrent modem processing
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "orange_pi_daemon_rust=info".to_string())
        )
        .init();
    
    // Check for benchmark mode
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "benchmark" {
        info!("🏁 Running performance benchmark...");
        return PerformanceBenchmark::run_benchmark().await;
    }

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

    info!("🚀 Starting Rust SMS Daemon v5.0.0 (Native D-Bus Edition)");
    info!("✨ Features: Native D-Bus, Zero subprocess overhead, Performance monitoring");
    info!("📡 API URL: {}", config.api_url);
    info!("⏱️  Device sync interval: {}s", config.check_interval_secs);

    // Initialize components
    let modem_manager = Arc::new(ModemManager::new().await);
    let api_client = ApiClient::new(config.clone());

    // Initialize SMS sender
    let mut sms_sender = SmsSender::new(api_client.clone(), modem_manager.clone());

    // Initialize sync manager with unique session ID
    let session_id = format!("rust-daemon-{}", uuid::Uuid::new_v4());
    let mut sync_manager = SyncManager::new(session_id, 300); // Full sync every 5 minutes

    // Initialize retry manager for network resilience
    let mut retry_manager = RetryManager::new(3, 1000); // 3 retries, 1s base delay

    // Initialize worker pool for parallel modem processing
    // Using default config which has been tuned for 92+ modems
    let worker_config = WorkerPoolConfig::default();
    let worker_pool = WorkerPool::new(worker_config.clone(), modem_manager.clone());
    info!("👷 Worker pool initialized with {} parallel workers", worker_config.num_workers);
    
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
    let mut last_watchdog = std::time::Instant::now();
    let sync_interval = Duration::from_secs(30); // Cloudflare requires ≥30s to avoid rate limits
    let watchdog_interval = Duration::from_secs(30); // Send watchdog ping every 30 seconds

    // Main event loop
    loop {
        cycle += 1;
        let cycle_start = std::time::Instant::now();

        // Send watchdog keepalive to systemd
        if last_watchdog.elapsed() >= watchdog_interval {
            let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Watchdog]);
            debug!("🐕 Sent watchdog keepalive to systemd");
            last_watchdog = std::time::Instant::now();
        }
        
        // Process modems in parallel using worker pool
        let modem_ids: Vec<String> = valid_modems.keys().cloned().collect();

        let mut all_messages = Vec::new();
        let mut all_phones = Vec::new();
        let mut all_sims = Vec::new();

        // Track performance metrics
        let process_start = std::time::Instant::now();

        // Process all modems in parallel with worker pool
        match worker_pool.process_modems(modem_ids.clone()).await {
            Ok(results) => {
                // Send watchdog keepalive after processing (long operation)
                let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Watchdog]);

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

                // Log detailed performance metrics
                let process_time = process_start.elapsed();
                let stats = worker_pool.get_stats().await;

                // Always log performance for monitoring
                info!("⚡ Performance: {} modems in {:.2}s ({:.0}ms/modem), {:.1}% success",
                    stats.total_modems,
                    process_time.as_secs_f64(),
                    process_time.as_millis() as f64 / stats.total_modems as f64,
                    stats.success_rate()
                );

                // Detailed stats every 10 cycles
                if cycle % 10 == 0 {
                    info!("📊 Detailed stats: Messages: {}, Phones: {}, SIMs: {}, Using: {}",
                        all_messages.len(),
                        all_phones.len(),
                        all_sims.len(),
                        if worker_pool.is_using_native_dbus().await { "Native D-Bus" } else { "Busctl fallback" }
                    );
                }
            }
            Err(e) => {
                error!("❌ Worker pool failed: {}", e);
            }
        }
        
        // Filter out invalid messages and upload if any valid ones found
        if !all_messages.is_empty() {
            let total_count = all_messages.len();

            // Filter out messages with missing or empty content
            let valid_messages: Vec<Message> = all_messages.into_iter()
                .filter(|msg| {
                    if msg.content.trim().is_empty() {
                        warn!("⚠️  Skipping message with empty content from ICCID: {}", msg.phone_iccid);
                        false
                    } else {
                        true
                    }
                })
                .collect();

            if !valid_messages.is_empty() {
                let filtered_count = total_count - valid_messages.len();
                if filtered_count > 0 {
                    info!("📤 Uploading {} valid messages to API (filtered out {} with empty content)",
                        valid_messages.len(),
                        filtered_count
                    );
                } else {
                    info!("📤 Uploading {} messages to API", valid_messages.len());
                }
                if let Err(e) = api_client.upload_messages(&valid_messages).await {
                    error!("❌ Failed to upload messages: {}", e);
                }
            } else {
                info!("📭 No valid messages to upload (all {} had empty content)", total_count);
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
