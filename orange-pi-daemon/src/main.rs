use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, error, info, warn};

// Import from the library crate
use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::benchmark::PerformanceBenchmark;
use orange_pi_daemon_rust::message_store::MessageStore;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::sms_sender::SmsSender;
use orange_pi_daemon_rust::sync_manager::{SyncManager, SyncMode};
use orange_pi_daemon_rust::types::*;
use orange_pi_daemon_rust::worker_pool::{WorkerPool, WorkerPoolConfig};

// V7.3.0 - EMERGENCY FIX FOR MODEMMANAGER DELETION FAILURE
// ModemManager refuses ALL SMS deletion requests, causing exponential message growth
// Workaround: Automatic cleanup every 5 minutes removes old pending messages
// Tasks:
// 1. Modem Reader: Reads SMS from modems every 1 second (6 workers)
// 2. Database Uploader: Dynamic batch size (10-100) based on message length, 50ms rate limiting
// 3. Device Status Sync: Syncs device status every 30 seconds
// 4. Statistics Logger: Logs database stats every 60 seconds
// 5. Auto Cleanup: Removes old pending messages every 5 minutes (workaround for deletion failure)
// 6. SMS Sender: Polls Cloudflare for pending outbound SMS and sends them via modems

#[tokio::main(flavor = "multi_thread", worker_threads = 4)] // Optimized for 4-core ARM CPU
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "orange_pi_daemon_rust=info".to_string()),
        )
        .init();

    // Parse command line arguments
    let args: Vec<String> = std::env::args().collect();

    // Check for --help
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("SMS Daemon v8.0.0 - Direct AT Commands for 100+ modems");
        println!();
        println!("USAGE:");
        println!("    {} [OPTIONS] [COMMAND]", args[0]);
        println!();
        println!("COMMANDS:");
        println!("    benchmark    Run performance benchmark");
        println!("    cleanup      Run database cleanup and exit");
        println!();
        println!("OPTIONS:");
        println!("    --db-path <PATH>    SQLite database path (default: /var/lib/sms-daemon/messages.db)");
        println!("    -h, --help          Print this help message");
        println!();
        println!("ENVIRONMENT VARIABLES:");
        println!("    MESSAGE_DB_PATH     SQLite database path (overridden by --db-path)");
        println!("    SMS_API_URL         API endpoint URL");
        println!("    SMS_API_KEY         API authentication key");
        println!(
            "    USE_DBUS            Set to '1' to use ModemManager D-Bus (default: AT commands)"
        );
        println!("    RUST_LOG            Log level (e.g., orange_pi_daemon_rust=debug)");
        return Ok(());
    }

    // Parse --db-path argument
    let db_path = args
        .windows(2)
        .find(|w| w[0] == "--db-path")
        .map(|w| w[1].clone())
        .or_else(|| std::env::var("MESSAGE_DB_PATH").ok())
        .unwrap_or_else(|| "/var/lib/sms-daemon/messages.db".to_string());

    // Check for benchmark mode
    if args.iter().any(|a| a == "benchmark") {
        info!("🏁 Running performance benchmark...");
        return PerformanceBenchmark::run_benchmark().await;
    }

    // Check for cleanup mode
    if args.iter().any(|a| a == "cleanup") {
        info!("🧹 Running database cleanup...");
        let message_store = Arc::new(MessageStore::new(&db_path)?);

        // Run aggressive cleanup
        let deleted = message_store.cleanup_all_old_pending()?;
        info!(
            "✅ Cleanup complete: {} old pending messages removed",
            deleted
        );
        return Ok(());
    }

    // Load configuration
    let api_url =
        std::env::var("SMS_API_URL").unwrap_or_else(|_| "http://localhost:8787".to_string());
    let api_key = std::env::var("SMS_API_KEY").unwrap_or_else(|_| {
        warn!("SMS_API_KEY not set, using default");
        "default_api_key".to_string()
    });

    let session_id = format!("rust-daemon-{}", uuid::Uuid::new_v4());
    info!("🚀 SMS Daemon v8.0.0 starting (Direct AT Commands)");
    info!("📡 Session ID: {}", session_id);
    info!("🌍 API URL: {}", api_url);
    info!("💾 Database: {}", db_path);

    // Initialize message store (SQLite database)
    let message_store = Arc::new(MessageStore::new(&db_path)?);

    // Clean up old pending messages on startup
    let cleaned = message_store.cleanup_all_old_pending()?;
    if cleaned > 0 {
        info!("🧹 Cleaned up {} old pending messages on startup", cleaned);
    }

    // Mark old uploaded messages as deleted (they have stale paths)
    let marked_deleted = message_store.mark_old_uploaded_as_deleted()?;
    if marked_deleted > 0 {
        info!(
            "✅ Marked {} old uploaded messages as deleted (stale paths)",
            marked_deleted
        );
    }

    // Initialize components
    let modem_manager = Arc::new(ModemManager::new().await);
    let config = Config {
        api_url: api_url.clone(),
        api_key: api_key.clone(),
        check_interval_secs: 1, // Fast 1-second check interval for dual-loop
    };
    let api_client = Arc::new(ApiClient::new(config));

    // Check modem manager is working
    if let Err(e) = modem_manager.list_modems().await {
        error!("❌ ModemManager not accessible: {}", e);
        error!("💡 Make sure ModemManager is running: systemctl status ModemManager");
        return Err(anyhow::anyhow!("ModemManager not accessible"));
    }

    // Initialize worker pool for parallel modem processing
    let worker_config = WorkerPoolConfig::default();
    let worker_pool = Arc::new(WorkerPool::new(
        worker_config.clone(),
        modem_manager.clone(),
    ));
    info!(
        "👷 Worker pool initialized with {} parallel workers (batch size: {})",
        worker_config.num_workers, worker_config.batch_size
    );

    // Build initial modem cache
    info!("🔄 Building initial modem cache...");
    let mut valid_modems: HashMap<String, String> = HashMap::new();
    match modem_manager.list_modems().await {
        Ok(modems) => {
            info!(
                "📋 Found {} modems, checking for SIM cards...",
                modems.len()
            );
            for modem_id in modems {
                match modem_manager.get_iccid(&modem_id).await {
                    Ok(Some(iccid)) => {
                        valid_modems.insert(modem_id.clone(), iccid.clone());
                        // Best-effort IMEI lookup for logging/diagnostics
                        let imei = match modem_manager.get_device_details(&modem_id).await {
                            Ok(Some((imei, ..))) => Some(imei),
                            Ok(None) => None,
                            Err(e) => {
                                warn!("⚠️  Failed to get IMEI for modem {}: {}", modem_id, e);
                                None
                            }
                        };

                        match imei {
                            Some(imei) => {
                                info!(
                                    "✅ Cached modem {} with ICCID {} (IMEI {})",
                                    modem_id, iccid, imei
                                );
                            }
                            None => {
                                info!(
                                    "✅ Cached modem {} with ICCID {} (IMEI unknown)",
                                    modem_id, iccid
                                );
                            }
                        }
                    }
                    Ok(None) => {
                        // Log IMEI for SIM-less modems for easier troubleshooting
                        let imei = match modem_manager.get_device_details(&modem_id).await {
                            Ok(Some((imei, ..))) => Some(imei),
                            Ok(None) => None,
                            Err(e) => {
                                warn!("⚠️  Failed to get IMEI for modem {}: {}", modem_id, e);
                                None
                            }
                        };

                        match imei {
                            Some(imei) => {
                                warn!("⚠️  Modem {} has no SIM card (IMEI {})", modem_id, imei);
                            }
                            None => {
                                warn!(
                                    "⚠️  Modem {} has no SIM card (IMEI unknown)",
                                    modem_id
                                );
                            }
                        }
                    }
                    Err(e) => {
                        warn!("⚠️  Failed to get ICCID for modem {}: {}", modem_id, e);
                    }
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to list modems: {}", e);
            return Err(anyhow::anyhow!("Failed to list modems"));
        }
    }

    if valid_modems.is_empty() {
        error!("❌ No modems with SIM cards found!");
        error!("💡 Check: mmcli -L");
        return Ok(());
    }

    let modem_ids: Vec<String> = valid_modems.keys().cloned().collect();

    // Notify systemd that we're ready
    let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Ready]);
    info!("🔔 Notified systemd - daemon is ready");

    info!(
        "🚀 Starting DUAL LOOP architecture with {} modems",
        valid_modems.len()
    );

    // TASK 1: MODEM READER (Fast Loop - every 1 second)
    // Reads SMS from modems and saves to database, then deletes from SIM immediately
    let modem_reader_store = message_store.clone();
    let modem_reader_manager = modem_manager.clone();
    let modem_reader_pool = worker_pool.clone();
    let modem_reader_ids = modem_ids.clone();

    tokio::spawn(async move {
        loop {
            let start = Instant::now();

            // Read from all modems in parallel
            match modem_reader_pool
                .process_modems(modem_reader_ids.clone())
                .await
            {
                Ok(results) => {
                    let mut count = 0;
                    let mut deleted_count = 0;
                    let mut deletion_failed_count = 0;
                    for result in results {
                        for msg_with_path in result.messages_with_paths {
                            // Save to SQLite immediately
                            match modem_reader_store.store_message(
                                &msg_with_path.message,
                                &msg_with_path.modem_id,
                                &msg_with_path.sms_path,
                            ) {
                                Ok(true) => {
                                    count += 1;

                                    // DELETE from SIM immediately (ALL messages - FIX for duplication bug)
                                    match modem_reader_manager
                                        .delete_sms(
                                            &msg_with_path.modem_id,
                                            &msg_with_path.sms_path,
                                        )
                                        .await
                                    {
                                        Ok(_) => {
                                            deleted_count += 1;
                                            debug!(
                                                "✅ Deleted SMS from SIM: {} (timestamp: {})",
                                                &msg_with_path.sms_path,
                                                &msg_with_path.message.timestamp
                                            );
                                        }
                                        Err(e) => {
                                            deletion_failed_count += 1;
                                            error!("❌ DELETION FAILED - modem: {}, path: {}, error: {}, timestamp: {}",
                                                   &msg_with_path.modem_id, &msg_with_path.sms_path, e, &msg_with_path.message.timestamp);
                                        }
                                    }
                                }
                                Ok(false) => {
                                    debug!("Duplicate message skipped");
                                }
                                Err(e) => {
                                    error!("Failed to store message: {}", e);
                                }
                            }
                        }
                    }

                    if count > 0 {
                        info!("📥 Modem reader: Stored {} new messages in {:?} (deleted: {}, failed: {})",
                              count, start.elapsed(), deleted_count, deletion_failed_count);
                    }
                }
                Err(e) => {
                    warn!("Modem reader error: {}", e);
                }
            }

            // Sleep 1 second before next modem check
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });

    // TASK 2: DATABASE UPLOADER (Dynamic Batch Size)
    // Uploads pending messages with smart batching based on payload size
    let upload_store = message_store.clone();
    let upload_client = api_client.clone();

    tokio::spawn(async move {
        info!("☁️  Dynamic batch uploader started - SMART SIZING with BACKOFF!");

        // Dynamic batch sizing: start small, grow if messages are short
        let mut current_batch_size = 50; // Start with 50 messages

        // Exponential backoff for API failures (prevents hammering overloaded Worker)
        let mut consecutive_failures: u32 = 0;
        const MAX_BACKOFF_SECS: u64 = 60; // Max 1 minute between retries

        loop {
            // Apply exponential backoff if we've had failures
            if consecutive_failures > 0 {
                let backoff_secs = (2u64.pow(consecutive_failures.min(6))).min(MAX_BACKOFF_SECS);
                warn!(
                    "☁️  Backoff: waiting {}s after {} consecutive failures",
                    backoff_secs, consecutive_failures
                );
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
            }

            // Get pending messages from database with dynamic batch
            match upload_store.get_pending_messages(current_batch_size) {
                Ok(pending) if !pending.is_empty() => {
                    let ids: Vec<i64> = pending.iter().map(|(id, _)| *id).collect();
                    let messages: Vec<Message> = pending.into_iter().map(|(_, msg)| msg).collect();

                    // Calculate approximate payload size
                    let payload_size: usize = messages
                        .iter()
                        .map(|m| m.content.len() + m.phone_number.len() + 100) // +100 for JSON overhead
                        .sum();

                    // Adjust batch size for next iteration based on current payload
                    if payload_size < 100_000
                        && ids.len() == current_batch_size
                        && consecutive_failures == 0
                    {
                        // Small payload and no failures, can increase batch size
                        current_batch_size = (current_batch_size * 2).min(100);
                    } else if payload_size > 500_000 || consecutive_failures > 2 {
                        // Large payload or API struggling, decrease batch size
                        current_batch_size = (current_batch_size / 2).max(10);
                    }

                    info!(
                        "☁️  Uploading {} messages (~{} KB)",
                        ids.len(),
                        payload_size / 1024
                    );

                    // Mark as uploading
                    if let Err(e) = upload_store.mark_uploading(&ids) {
                        error!("Failed to mark as uploading: {}", e);
                        continue;
                    }

                    // Upload to Cloudflare
                    match upload_client.upload_messages(&messages).await {
                        Ok(_) => {
                            info!("☁️  Uploader: Sent {} messages to Cloudflare", ids.len());
                            // Mark as uploaded in database
                            let _ = upload_store.mark_uploaded(&ids);
                            // Reset backoff on success
                            consecutive_failures = 0;
                            // Small delay to avoid rate limits
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        Err(e) => {
                            warn!("☁️  Uploader: Failed to upload: {}", e);
                            // Mark as failed for retry
                            let _ = upload_store.mark_failed(&ids, &e.to_string());
                            // Increment failure counter for backoff
                            consecutive_failures = consecutive_failures.saturating_add(1);
                        }
                    }
                }
                _ => {
                    // No pending messages, wait before checking again
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });

    // TASK 3: DEVICE STATUS SYNC (Slow Loop - every 30 seconds)
    // Syncs device status and phone information to API
    let sync_client = api_client.clone();
    let sync_manager_arc = Arc::new(tokio::sync::Mutex::new(SyncManager::new(
        session_id.clone(),
        300,
    )));
    let sync_pool = worker_pool.clone();
    let sync_ids = modem_ids.clone();

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            // Collect device status
            let mut all_phones = Vec::new();
            let mut all_sims = Vec::new();

            match sync_pool.process_modems(sync_ids.clone()).await {
                Ok(results) => {
                    for result in results {
                        if let Some(phone) = result.phone {
                            all_phones.push(phone);
                        }
                        if let Some(sim) = result.sim {
                            all_sims.push(sim);
                        }
                    }

                    // Determine sync mode
                    let mut sync_manager = sync_manager_arc.lock().await;
                    let sync_mode = if sync_manager.needs_full_sync() {
                        SyncMode::Full
                    } else {
                        SyncMode::Incremental
                    };

                    // Convert Phone to Modem for API
                    let modems: Vec<Modem> = all_phones
                        .iter()
                        .map(|p| Modem {
                            equipment_id: p.imei.clone().unwrap_or_else(|| "unknown".to_string()),
                            manufacturer: p.manufacturer.clone(),
                            model: p.model.clone(),
                            firmware_revision: p.firmware_revision.clone(),
                            hardware_revision: p.hardware_revision.clone(),
                            status: p.status.clone(),
                            signal: p.signal,
                            rssi: p.rssi,
                            rsrq: p.rsrq,
                            rsrp: p.rsrp,
                            snr: p.snr,
                            modem_index: p.modem_index,
                            usb_port: p.usb_port.as_ref().and_then(|s| s.parse::<i32>().ok()),
                            connection_status: Some(p.status.clone()),
                            network_type: None,
                            access_tech: p.access_tech.clone(),
                        })
                        .collect();

                    // Upload device status
                    match sync_client
                        .upload_devices(&modems, &all_sims, sync_mode, &session_id)
                        .await
                    {
                        Ok(_) => {
                            info!(
                                "📊 Status sync: Updated {} devices (mode: {:?})",
                                all_phones.len(),
                                sync_mode
                            );
                            sync_manager.record_success(sync_mode);
                        }
                        Err(e) => {
                            warn!("Status sync failed: {}", e);
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to collect device status: {}", e);
                }
            }
        }
    });

    // TASK 4: STATISTICS LOGGER (every 60 seconds)
    // Logs database statistics for monitoring
    let stats_store = message_store.clone();

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            if let Ok(stats) = stats_store.get_stats() {
                info!(
                    "📊 Database stats: {} pending, {} uploading, {} uploaded, {} failed",
                    stats.pending, stats.uploading, stats.uploaded, stats.failed
                );

                // Check for SIM cards with many messages
                if let Ok(full_sims) = stats_store.check_sim_storage() {
                    if !full_sims.is_empty() {
                        warn!(
                            "⚠️  SIMs with >200 messages in DB: {} cards",
                            full_sims.len()
                        );
                    }
                }
            }
        }
    });

    // TASK 5: AUTOMATIC CLEANUP (every 5 minutes)
    // Since ModemManager won't delete SMS from SIM cards, we need periodic cleanup
    let cleanup_store = message_store.clone();

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await; // Every 5 minutes

            // Clean up old pending messages that can't be deleted from SIM
            match cleanup_store.cleanup_all_old_pending() {
                Ok(deleted) if deleted > 0 => {
                    warn!("🧹 AUTO-CLEANUP: Removed {} old pending messages (ModemManager deletion failure workaround)", deleted);
                }
                Ok(_) => {
                    debug!("🧹 Auto-cleanup: No old pending messages to remove");
                }
                Err(e) => {
                    error!("❌ Auto-cleanup failed: {}", e);
                }
            }

            // Also mark old uploaded messages as deleted to prevent deletion attempts
            if let Ok(marked) = cleanup_store.mark_old_uploaded_as_deleted() {
                if marked > 0 {
                    info!(
                        "✅ Marked {} old uploaded messages as deleted (stale paths)",
                        marked
                    );
                }
            }
        }
    });

    // TASK 6: SMS SENDER (every 10 seconds)
    // Polls Cloudflare for pending outbound SMS and sends them via AT commands
    let sender_api_client = (*api_client).clone();
    let sender_modem_manager = modem_manager.clone();
    let sender_modem_cache: HashMap<String, String> = valid_modems
        .iter()
        .map(|(modem_id, iccid)| (iccid.clone(), modem_id.clone()))
        .collect();

    tokio::spawn(async move {
        info!("📤 SMS Sender task started - polling every 10 seconds");

        let mut sms_sender = SmsSender::new(sender_api_client, sender_modem_manager);
        sms_sender.update_modem_cache(sender_modem_cache);

        loop {
            match sms_sender.process_pending_sms().await {
                Ok(_) => {
                    // Success (may have sent 0 or more messages)
                }
                Err(e) => {
                    warn!("📤 SMS Sender error: {}", e);
                }
            }

            // Poll every 10 seconds for pending SMS
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });

    // Main thread just monitors health
    info!("✨ All tasks spawned - system running in dual-loop mode");
    loop {
        tokio::time::sleep(Duration::from_secs(300)).await;
        info!("💓 Heartbeat - daemon is healthy");
    }
}
