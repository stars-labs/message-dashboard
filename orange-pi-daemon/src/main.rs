use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

// Import from the library crate
use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::benchmark::PerformanceBenchmark;
use orange_pi_daemon_rust::health::{HealthTask, HealthTracker};
use orange_pi_daemon_rust::logging;
use orange_pi_daemon_rust::message_store::MessageStore;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::sms_sender::SmsSender;
use orange_pi_daemon_rust::sync_manager::{
    device_delta, merge_device_reports, DeviceDelta, SyncManager, SyncMode,
};
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
    logging::init()?;

    // Parse command line arguments
    let args: Vec<String> = std::env::args().collect();

    // Check for --help
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "SMS Daemon v{} - Direct AT Commands for 100+ modems",
            env!("CARGO_PKG_VERSION")
        );
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
    info!(
        "🚀 SMS Daemon v{} starting (Direct AT Commands)",
        env!("CARGO_PKG_VERSION")
    );
    info!("📡 Session ID: {}", session_id);
    info!("🌍 API URL: {}", api_url);
    info!("💾 Database: {}", db_path);

    // Initialize message store (SQLite database)
    let message_store = Arc::new(MessageStore::new(&db_path)?);

    // Note: Multipart SMS assembly is handled inline in modem_manager.rs
    // No separate assembler instance needed - PDU parser extracts concat info
    // and messages are assembled during the read operation

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
        message_store.clone(),
    ));
    info!(
        "👷 Worker pool initialized with {} parallel workers (batch size: {})",
        worker_config.num_workers, worker_config.batch_size
    );

    // Build initial modem cache
    info!("🔄 Building initial modem cache...");
    let mut valid_modems: HashMap<String, Option<String>> = HashMap::new();
    match modem_manager.list_modems().await {
        Ok(modems) => {
            info!(
                "📋 Found {} modems, checking for SIM cards...",
                modems.len()
            );
            for modem_id in modems {
                // Try IMEI first — this is the gate
                let imei = match modem_manager.get_device_details(&modem_id).await {
                    Ok(Some((imei, ..))) => Some(imei),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("⚠️  Failed to get IMEI for modem {}: {}", modem_id, e);
                        None
                    }
                };

                if imei.is_none() {
                    warn!("⚠️  Modem {} has no valid IMEI, skipping", modem_id);
                    continue;
                }

                // Try ICCID — optional, modem is still valid without it
                let iccid = match modem_manager.get_iccid(&modem_id).await {
                    Ok(Some(iccid)) => Some(iccid),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("⚠️  Failed to get ICCID for modem {}: {}", modem_id, e);
                        None
                    }
                };

                valid_modems.insert(modem_id.clone(), iccid.clone());

                match (&imei, &iccid) {
                    (Some(imei), Some(iccid)) => {
                        info!(
                            "✅ Cached modem {} with ICCID {} (IMEI {})",
                            modem_id, iccid, imei
                        );
                    }
                    (Some(imei), None) => {
                        warn!(
                            "⚠️  Cached modem {} without ICCID (IMEI {}) — SIM read failed",
                            modem_id, imei
                        );
                    }
                    _ => unreachable!(),
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to list modems: {}", e);
            return Err(anyhow::anyhow!("Failed to list modems"));
        }
    }

    if valid_modems.is_empty() {
        error!("❌ No modems with valid IMEI found!");
        error!("💡 Check: mmcli -L");
        return Ok(());
    }

    let modem_ids: Vec<String> = valid_modems.keys().cloned().collect();

    // Live modem set, shared and mutable: the reader loop reads it each tick and the
    // re-discovery task (Task 8) reconciles additions and physical removals.
    let modem_set: Arc<RwLock<Vec<String>>> = Arc::new(RwLock::new(modem_ids.clone()));

    // Notify systemd that we're ready
    let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Ready]);
    info!("🔔 Notified systemd - daemon is ready");

    info!(
        "🚀 Starting DUAL LOOP architecture with {} modems",
        valid_modems.len()
    );

    // Shared buffer: Task 1 (modem reader) writes latest ModemReport results here,
    // Task 3 (device sync) reads from it. This avoids two pools fighting over serial ports.
    let latest_devices: Arc<RwLock<HashMap<String, ModemReport>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let health_tracker = Arc::new(RwLock::new(HealthTracker::new(
        session_id.clone(),
        env!("CARGO_PKG_VERSION").to_string(),
        valid_modems.len(),
    )));

    // TASK 1: MODEM READER (Fast Loop - every 1 second)
    // Reads SMS from modems and saves to database, then deletes from SIM immediately
    let modem_reader_store = message_store.clone();
    let modem_reader_manager = modem_manager.clone();
    let modem_reader_pool = worker_pool.clone();
    let modem_reader_set = modem_set.clone();
    let reader_devices = latest_devices.clone();
    let reader_health = health_tracker.clone();

    tokio::spawn(async move {
        loop {
            let start = Instant::now();

            // Snapshot the current live modem set (Task 8 may have reconciled it).
            let current_ids = modem_reader_set.read().await.clone();
            let discovered_count = current_ids.len();
            reader_health
                .write()
                .await
                .record_attempt(HealthTask::ModemReader);

            // Read from all modems in parallel
            match modem_reader_pool.process_modems(current_ids.clone()).await {
                Ok(results) => {
                    // Collect modem reports for the device sync task
                    let mut reports = Vec::new();
                    let mut count = 0;
                    let mut deleted_count = 0;
                    let mut deletion_failed_count = 0;
                    for result in results {
                        if let Some(report) = result.report.clone() {
                            reports.push((result.modem_id.clone(), report));
                        }
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

                    let responsive_count = reports.len();
                    let sim_readable_count = reports
                        .iter()
                        .filter(|(_, report)| report.detected_iccid.is_some())
                        .count();
                    {
                        let mut health = reader_health.write().await;
                        health.set_modem_counts(
                            discovered_count,
                            responsive_count,
                            sim_readable_count,
                        );
                        health.record_success(HealthTask::ModemReader);
                    }

                    // Preserve the last successful report for transient AT failures.
                    // Only USB discovery is allowed to remove a modem from this snapshot.
                    let mut devices = reader_devices.write().await;
                    *devices = merge_device_reports(&devices, &current_ids, reports);
                }
                Err(e) => {
                    warn!("Modem reader error: {}", e);
                    reader_health
                        .write()
                        .await
                        .record_failure(HealthTask::ModemReader, &e);
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
    let upload_health = health_tracker.clone();

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
                    upload_health
                        .write()
                        .await
                        .record_attempt(HealthTask::MessageUploader);
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
                        upload_health
                            .write()
                            .await
                            .record_failure(HealthTask::MessageUploader, &e);
                        continue;
                    }
                    upload_health.write().await.set_in_flight_uploads(ids.len());

                    // Upload to Cloudflare
                    match upload_client.upload_messages(&messages).await {
                        Ok(_) => {
                            info!("☁️  Uploader: Sent {} messages to Cloudflare", ids.len());
                            // Mark as uploaded in database
                            let _ = upload_store.mark_uploaded(&ids);
                            upload_health.write().await.set_in_flight_uploads(0);
                            // Reset backoff on success
                            consecutive_failures = 0;
                            upload_health
                                .write()
                                .await
                                .record_success(HealthTask::MessageUploader);
                            // Small delay to avoid rate limits
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        Err(e) => {
                            warn!(
                                event = "cloud_sync_failed",
                                operation = "message_upload",
                                error_code = "cloud_api_request_failed",
                                consecutive_failures = consecutive_failures.saturating_add(1),
                                error = %e,
                                "Uploader failed to send messages"
                            );
                            // Mark as failed for retry
                            let _ = upload_store.mark_failed(&ids, &e.to_string());
                            upload_health.write().await.set_in_flight_uploads(0);
                            // Increment failure counter for backoff
                            consecutive_failures = consecutive_failures.saturating_add(1);
                            upload_health
                                .write()
                                .await
                                .record_failure(HealthTask::MessageUploader, &e);
                        }
                    }
                }
                Ok(_) => {
                    // No pending messages, wait before checking again
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => {
                    warn!("☁️  Uploader: Failed to read local queue: {}", e);
                    upload_health
                        .write()
                        .await
                        .record_failure(HealthTask::MessageUploader, &e);
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });

    // TASK 3: DEVICE STATUS SYNC (Slow Loop - every 30 seconds)
    // Reads latest device data from shared buffer (populated by Task 1) and syncs to API.
    // This avoids a second process_modems() call that would fight over serial ports.
    let sync_client = api_client.clone();
    let sync_manager_arc = Arc::new(tokio::sync::Mutex::new(SyncManager::new()));
    let sync_devices = latest_devices.clone();
    let sync_modem_set = modem_set.clone();
    let sync_health = health_tracker.clone();
    let sync_session_id = session_id.clone();

    tokio::spawn(async move {
        let mut last_synced_reports = Vec::new();

        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            // Read latest modem reports from shared buffer (populated by Task 1)
            let all_reports = {
                let devices = sync_devices.read().await;
                let mut reports: Vec<ModemReport> = devices.values().cloned().collect();
                reports.sort_by(|left, right| left.equipment_id.cmp(&right.equipment_id));
                reports
            };
            let discovered_count = sync_modem_set.read().await.len();

            sync_health
                .write()
                .await
                .record_attempt(HealthTask::DeviceSync);
            if all_reports.is_empty() && discovered_count > 0 {
                sync_health
                    .write()
                    .await
                    .record_failure(HealthTask::DeviceSync, "no modem reports available");
                warn!("Status sync skipped: no modem reports available");
                continue;
            }

            // Determine sync mode
            let mut sync_manager = sync_manager_arc.lock().await;
            let sync_mode = if sync_manager.needs_full_sync() {
                SyncMode::Full
            } else {
                SyncMode::Incremental
            };
            let delta = if sync_mode == SyncMode::Full {
                DeviceDelta {
                    reports: all_reports.clone(),
                    removed_equipment_ids: Vec::new(),
                }
            } else {
                device_delta(&last_synced_reports, &all_reports)
            };

            if sync_mode == SyncMode::Incremental
                && delta.reports.is_empty()
                && delta.removed_equipment_ids.is_empty()
            {
                last_synced_reports = all_reports;
                sync_manager.record_success(sync_mode);
                sync_health
                    .write()
                    .await
                    .record_success(HealthTask::DeviceSync);
                continue;
            }

            match sync_client
                .upload_modem_reports(
                    &delta.reports,
                    &delta.removed_equipment_ids,
                    sync_mode,
                    &sync_session_id,
                )
                .await
            {
                Ok(_) => {
                    info!(
                        "📊 Status sync: {} changed, {} removed (mode: {:?})",
                        delta.reports.len(),
                        delta.removed_equipment_ids.len(),
                        sync_mode
                    );
                    last_synced_reports = all_reports;
                    sync_manager.record_success(sync_mode);
                    sync_health
                        .write()
                        .await
                        .record_success(HealthTask::DeviceSync);
                }
                Err(e) => {
                    warn!(
                        event = "cloud_sync_failed",
                        operation = "device_sync",
                        error_code = "cloud_api_request_failed",
                        error = %e,
                        "Device status sync failed"
                    );
                    sync_manager.record_failure(sync_mode, e.as_ref());
                    sync_health
                        .write()
                        .await
                        .record_failure(HealthTask::DeviceSync, &e);
                }
            }
        }
    });

    // TASK 4: STATISTICS LOGGER (every 60 seconds)
    // Logs database statistics for monitoring
    let stats_store = message_store.clone();
    let stats_health = health_tracker.clone();

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

            if let Ok(queue) = stats_store.get_queue_stats() {
                let queue = stats_health.read().await.queue_snapshot(
                    queue.retryable,
                    queue.attempts_exhausted,
                    queue.uploading,
                );
                if queue.attempts_exhausted > 0 {
                    error!(
                        event = "message_queue_attempts_exhausted",
                        count = queue.attempts_exhausted,
                        "Messages require operator recovery"
                    );
                }
                if queue.stuck_uploading > 0 {
                    error!(
                        event = "message_queue_stuck_uploading",
                        count = queue.stuck_uploading,
                        "Messages are stuck in uploading state"
                    );
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

    // TASK 5b: MULTIPART SEGMENTS CLEANUP (every 5 minutes)
    // Clean up incomplete multipart SMS segments older than 5 minutes
    let segment_cleanup_store = message_store.clone();

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await; // Every 5 minutes

            // Clean up segments older than 5 minutes (300 seconds)
            match segment_cleanup_store.cleanup_old_segments(300) {
                Ok(deleted) if deleted > 0 => {
                    warn!(
                        "🧹 SEGMENT-CLEANUP: Removed {} expired multipart segments (>5min old)",
                        deleted
                    );
                }
                Ok(_) => {
                    debug!("🧹 Segment cleanup: No expired multipart segments");
                }
                Err(e) => {
                    error!("❌ Segment cleanup failed: {}", e);
                }
            }
        }
    });

    // TASK 6: SMS SENDER (every 10 seconds)
    // Polls Cloudflare for pending outbound SMS and sends them via AT commands
    let sender_api_client = (*api_client).clone();
    let sender_modem_manager = modem_manager.clone();
    let sender_health = health_tracker.clone();
    let sender_modem_cache: HashMap<String, String> = valid_modems
        .iter()
        .filter_map(|(modem_id, iccid)| iccid.as_ref().map(|i| (i.clone(), modem_id.clone())))
        .collect();

    tokio::spawn(async move {
        info!("📤 SMS Sender task started - polling every 10 seconds");

        let mut sms_sender =
            SmsSender::new(sender_api_client, sender_modem_manager, session_id.clone());
        sms_sender.update_modem_cache(sender_modem_cache);

        loop {
            sender_health
                .write()
                .await
                .record_attempt(HealthTask::OutboundPoll);
            match sms_sender.process_pending_sms().await {
                Ok(_) => {
                    sender_health
                        .write()
                        .await
                        .record_success(HealthTask::OutboundPoll);
                }
                Err(e) => {
                    warn!(
                        event = "cloud_sync_failed",
                        operation = "outbound_poll",
                        error_code = "cloud_api_request_failed",
                        error = %e,
                        "Outbound SMS poll failed"
                    );
                    sender_health
                        .write()
                        .await
                        .record_failure(HealthTask::OutboundPoll, &e);
                }
            }

            // Poll every 10 seconds for pending SMS
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });

    // TASK 7: INDEPENDENT HEALTH HEARTBEAT (every 60 seconds)
    // This is deliberately separate from outbound polling and device sync so one
    // healthy task cannot hide another stalled task.
    let heartbeat_client = api_client.clone();
    let heartbeat_health = health_tracker.clone();
    let heartbeat_store = message_store.clone();

    tokio::spawn(async move {
        info!("💓 Independent health heartbeat started - reporting every 60 seconds");
        loop {
            let queue_stats = heartbeat_store.get_queue_stats().unwrap_or_default();
            let snapshot = {
                let health = heartbeat_health.read().await;
                let queue = health.queue_snapshot(
                    queue_stats.retryable,
                    queue_stats.attempts_exhausted,
                    queue_stats.uploading,
                );
                health.snapshot(queue)
            };
            if let Err(e) = heartbeat_client.send_health_snapshot(&snapshot).await {
                warn!(
                    event = "cloud_sync_failed",
                    operation = "health_heartbeat",
                    error_code = "cloud_api_request_failed",
                    error = %e,
                    "Health heartbeat failed"
                );
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });

    // TASK 8: DYNAMIC MODEM RE-DISCOVERY (every 60 seconds)
    // Reconciles physical USB removal and picks up modems that enumerate after startup.
    // Newly enumerated but silent devices receive one USB reset attempt.
    let rediscover_manager = modem_manager.clone();
    let rediscover_set = modem_set.clone();

    tokio::spawn(async move {
        info!("🔎 Modem re-discovery task started - scanning every 60 seconds");
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            match rediscover_manager.reconcile_modems().await {
                Ok(current) => {
                    let mut set = rediscover_set.write().await;
                    if *set == current {
                        debug!("🔎 Re-discovery: modem set unchanged");
                    } else {
                        info!(
                            "🔎 Re-discovery: reconciled modem set from {} to {}",
                            set.len(),
                            current.len()
                        );
                        *set = current;
                    }
                }
                Err(e) => warn!("🔎 Re-discovery failed: {}", e),
            }
        }
    });

    // Main thread just monitors health
    info!("✨ All tasks spawned - system running in dual-loop mode");
    loop {
        tokio::time::sleep(Duration::from_secs(300)).await;
        info!("💓 Heartbeat - daemon is healthy");
    }
}
