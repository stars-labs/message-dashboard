use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

// Import from the library crate
use orange_pi_daemon_rust::api_client::{ApiClient, UploadResult};
use orange_pi_daemon_rust::benchmark::PerformanceBenchmark;
use orange_pi_daemon_rust::health::{HealthTask, HealthTracker};
use orange_pi_daemon_rust::identifiers::Iccid;
use orange_pi_daemon_rust::logging;
use orange_pi_daemon_rust::message_store::{MessageStore, StoredMessage};
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::sms_sender::SmsSender;
use orange_pi_daemon_rust::stall_watchdog::{self, Heartbeat, STALL_AFTER};
use orange_pi_daemon_rust::sync_manager::{
    device_delta, merge_device_reports, DeviceDelta, SyncManager, SyncMode,
};
use orange_pi_daemon_rust::timeout_tracker::TimeoutTracker;
use orange_pi_daemon_rust::types::{Config, MessageWithPath, ModemReport, UploadStatus};
use orange_pi_daemon_rust::voice_bridge::{VoiceBridge, VoiceBridgeConfig};
use orange_pi_daemon_rust::worker_pool::{ModemResult, WorkerPool, WorkerPoolConfig};

type SharedHealth = Arc<RwLock<HealthTracker>>;
type SharedDevices = Arc<RwLock<HashMap<String, ModemReport>>>;

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

fn print_help(program: &str) {
    println!(
        "SMS Daemon v{} - Direct AT Commands for 100+ modems",
        env!("CARGO_PKG_VERSION")
    );
    println!();
    println!("USAGE:");
    println!("    {program} [OPTIONS] [COMMAND]");
    println!();
    println!("COMMANDS:");
    println!("    benchmark    Run performance benchmark");
    println!("    cleanup      Run database cleanup and exit");
    println!();
    println!("OPTIONS:");
    println!(
        "    --db-path <PATH>    SQLite database path (default: /var/lib/sms-daemon/messages.db)"
    );
    println!("    -h, --help          Print this help message");
    println!();
    println!("ENVIRONMENT VARIABLES:");
    println!("    MESSAGE_DB_PATH     SQLite database path (overridden by --db-path)");
    println!("    SMS_API_URL         API endpoint URL");
    println!("    SMS_API_KEY         API authentication key");
    println!("    USE_DBUS            Set to '1' to use ModemManager D-Bus (default: AT commands)");
    println!("    RUST_LOG            Log level (e.g., orange_pi_daemon_rust=debug)");
}

/// Probe every listed modem; a modem needs a valid IMEI to be cached, and its
/// ICCID is optional.
async fn build_modem_cache(modem_manager: &ModemManager) -> Result<HashMap<String, Option<Iccid>>> {
    info!("🔄 Building initial modem cache...");
    let mut valid_modems: HashMap<String, Option<Iccid>> = HashMap::new();
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

                let Some(imei) = imei else {
                    warn!("⚠️  Modem {} has no valid IMEI, skipping", modem_id);
                    continue;
                };

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

                if let Some(iccid) = &iccid {
                    info!(
                        "✅ Cached modem {} with ICCID {} (IMEI {})",
                        modem_id, iccid, imei
                    );
                } else {
                    warn!(
                        "⚠️  Cached modem {} without ICCID (IMEI {}) — SIM read failed",
                        modem_id, imei
                    );
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to list modems: {}", e);
            return Err(anyhow::anyhow!("Failed to list modems"));
        }
    }
    Ok(valid_modems)
}

#[derive(Default)]
struct ReaderCounts {
    stored: usize,
    deleted: usize,
    stale_deleted: usize,
    deletion_failed: usize,
}

/// Save one SMS to SQLite, then delete it from the SIM.
async fn store_and_delete(
    store: &MessageStore,
    manager: &ModemManager,
    msg_with_path: &MessageWithPath,
    counts: &mut ReaderCounts,
) {
    // Save to SQLite immediately
    match store.store_message(
        &msg_with_path.message,
        &msg_with_path.modem_id,
        &msg_with_path.sms_path,
    ) {
        Ok(true) => {
            counts.stored += 1;

            // DELETE from SIM immediately (ALL messages - FIX for duplication bug)
            match manager
                .delete_sms(&msg_with_path.modem_id, &msg_with_path.sms_path)
                .await
            {
                Ok(()) => {
                    counts.deleted += 1;
                    debug!(
                        "✅ Deleted SMS from SIM: {} (timestamp: {})",
                        &msg_with_path.sms_path, &msg_with_path.message.timestamp
                    );
                }
                Err(e) => {
                    counts.deletion_failed += 1;
                    error!(
                        "❌ DELETION FAILED - modem: {}, path: {}, error: {}, timestamp: {}",
                        &msg_with_path.modem_id,
                        &msg_with_path.sms_path,
                        e,
                        &msg_with_path.message.timestamp
                    );
                }
            }
        }
        Ok(false) => {
            // Already in the local store, so the SIM copy is
            // redundant — and it must still be deleted. Skipping
            // it here stranded a message on the SIM for good
            // whenever a reset landed between "stored" and
            // "deleted": it was then re-read and re-assembled on
            // every scan (65 messages, 8 GB of SD writes an hour
            // by 2026-09-18), and a SIM that fills up makes the
            // carrier drop new SMS.
            match manager
                .delete_sms(&msg_with_path.modem_id, &msg_with_path.sms_path)
                .await
            {
                Ok(()) => {
                    counts.stale_deleted += 1;
                }
                Err(e) => {
                    counts.deletion_failed += 1;
                    error!(
                        "❌ DELETION FAILED (already stored) - modem: {}, path: {}, error: {}",
                        &msg_with_path.modem_id, &msg_with_path.sms_path, e
                    );
                }
            }
        }
        Err(e) => {
            error!("Failed to store message: {}", e);
        }
    }
}

/// Persist one read cycle's messages and collect the modem reports for the
/// device sync task.
async fn store_read_results(
    results: Vec<ModemResult>,
    timeouts: &mut TimeoutTracker,
    store: &MessageStore,
    manager: &ModemManager,
    start: Instant,
) -> Vec<(String, ModemReport)> {
    let mut reports = Vec::new();
    let mut counts = ReaderCounts::default();
    for result in results {
        // A modem that keeps timing out is forgotten so the next
        // reconcile probes its USB device again. Rediscovery never
        // touches a cached modem, so without this a wedged or
        // wrongly cached one timed out on every scan for good.
        let timed_out = result.error.as_deref() == Some("Timeout");
        if timeouts.record(&result.modem_id, timed_out) {
            manager.forget_modem(&result.modem_id).await;
        }
        if let Some(report) = result.report.clone() {
            reports.push((result.modem_id.clone(), report));
        }
        for msg_with_path in result.messages_with_paths {
            store_and_delete(store, manager, &msg_with_path, &mut counts).await;
        }
    }

    if counts.stored > 0 {
        info!(
            "📥 Modem reader: Stored {} new messages in {:?} (deleted: {}, failed: {})",
            counts.stored,
            start.elapsed(),
            counts.deleted,
            counts.deletion_failed
        );
    }
    if counts.stale_deleted > 0 {
        info!(
            "🧹 Modem reader: removed {} already-stored messages left on SIMs",
            counts.stale_deleted
        );
    }
    reports
}

struct ModemReader {
    store: Arc<MessageStore>,
    manager: Arc<ModemManager>,
    pool: Arc<WorkerPool>,
    modem_set: Arc<RwLock<Vec<String>>>,
    devices: SharedDevices,
    health: SharedHealth,
    heartbeat: Heartbeat,
}

/// TASK 1: MODEM READER (Fast Loop - every 1 second)
/// Reads SMS from modems and saves to database, then deletes from SIM immediately
fn spawn_modem_reader(reader: ModemReader) {
    tokio::spawn(async move {
        let mut timeouts = TimeoutTracker::default();
        loop {
            let start = Instant::now();

            // Snapshot the current live modem set (Task 8 may have reconciled it).
            let current_ids = reader.modem_set.read().await.clone();

            // Read from all modems in parallel
            match reader.pool.process_modems(current_ids.clone()).await {
                Ok(results) => {
                    let reports = store_read_results(
                        results,
                        &mut timeouts,
                        &reader.store,
                        &reader.manager,
                        start,
                    )
                    .await;

                    reader
                        .health
                        .write()
                        .await
                        .record_success(HealthTask::ModemReader);
                    reader.heartbeat.beat();

                    // Preserve the last successful report for transient AT failures.
                    // Only USB discovery is allowed to remove a modem from this snapshot.
                    let mut devices = reader.devices.write().await;
                    *devices = merge_device_reports(&devices, &current_ids, reports);
                }
                Err(e) => {
                    warn!("Modem reader error: {}", e);
                }
            }

            // Sleep 1 second before next modem check
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

/// How a batch's upload response sorts the batch's messages.
#[derive(Default)]
struct UploadClassification {
    acknowledged: Vec<StoredMessage>,
    dead_letter: Vec<StoredMessage>,
    retryable: Vec<StoredMessage>,
    unknown_ids: Vec<String>,
}

fn classify_upload_results(
    pending: &[StoredMessage],
    results: &[UploadResult],
) -> UploadClassification {
    let mut classification = UploadClassification::default();
    for result in results {
        if let Some(message) = pending.iter().find(|m| m.source_message_id == result.id) {
            match result.status {
                UploadStatus::Stored | UploadStatus::AlreadyStored => {
                    classification.acknowledged.push(message.clone());
                }
                UploadStatus::Rejected if !result.retryable => {
                    classification.dead_letter.push(message.clone());
                }
                UploadStatus::Rejected | UploadStatus::Unknown(_) => {
                    classification.retryable.push(message.clone());
                }
            }
        } else {
            classification.unknown_ids.push(result.id.clone());
        }
    }
    classification
}

struct Uploader {
    store: Arc<MessageStore>,
    client: Arc<ApiClient>,
    health: SharedHealth,
    // Dynamic batch sizing: start small, grow if messages are short
    batch_size: usize,
    // Exponential backoff for API failures (prevents hammering overloaded Worker)
    consecutive_failures: u32,
}

impl Uploader {
    const MAX_BACKOFF_SECS: u64 = 60; // Max 1 minute between retries

    fn new(store: Arc<MessageStore>, client: Arc<ApiClient>, health: SharedHealth) -> Self {
        Self {
            store,
            client,
            health,
            batch_size: 50, // Start with 50 messages
            consecutive_failures: 0,
        }
    }

    async fn run_cycle(&mut self) {
        // Apply exponential backoff if we've had failures
        if self.consecutive_failures > 0 {
            let backoff_secs =
                (2u64.pow(self.consecutive_failures.min(6))).min(Self::MAX_BACKOFF_SECS);
            warn!(
                "☁️  Backoff: waiting {}s after {} consecutive failures",
                backoff_secs, self.consecutive_failures
            );
            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        }

        // Get pending messages from database with dynamic batch
        match self.store.claim_messages(self.batch_size, 90) {
            Ok(pending) if !pending.is_empty() => self.upload_batch(pending).await,
            Ok(_) => {
                // No pending messages, wait before checking again
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                warn!("☁️  Uploader: Failed to read local queue: {}", e);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }

    async fn upload_batch(&mut self, pending: Vec<StoredMessage>) {
        // Calculate approximate payload size
        let payload_size: usize = pending
            .iter()
            .map(|m| m.message.content.len() + m.message.phone_number.as_str().len() + 100) // +100 for JSON overhead
            .sum();

        // Adjust batch size for next iteration based on current payload
        if payload_size < 100_000
            && pending.len() == self.batch_size
            && self.consecutive_failures == 0
        {
            // Small payload and no failures, can increase batch size
            self.batch_size = (self.batch_size * 2).min(100);
        } else if payload_size > 500_000 || self.consecutive_failures > 2 {
            // Large payload or API struggling, decrease batch size
            self.batch_size = (self.batch_size / 2).max(10);
        }

        info!(
            "☁️  Uploading {} messages (~{} KB)",
            pending.len(),
            payload_size / 1024
        );

        // Upload to Cloudflare
        match self.client.upload_messages(&pending).await {
            Ok(results) => self.finish_upload(&pending, &results).await,
            Err(e) => {
                warn!(
                    event = "cloud_sync_failed",
                    operation = "message_upload",
                    error_code = "cloud_api_request_failed",
                    consecutive_failures = self.consecutive_failures.saturating_add(1),
                    error = %e,
                    "Uploader failed to send messages"
                );
                // Mark as failed for retry
                let _ = self.store.return_to_pending(&pending, &e.to_string());
                // Increment failure counter for backoff
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            }
        }
    }

    async fn finish_upload(&mut self, pending: &[StoredMessage], results: &[UploadResult]) {
        let classification = classify_upload_results(pending, results);
        for id in &classification.unknown_ids {
            // Worker returned an ID we didn't send — infrastructure bug,
            // treat the whole batch as transient failure.
            warn!("Worker returned unknown id {} in upload response", id);
            let _ = self
                .store
                .return_to_pending(pending, "Worker returned unrecognised message id");
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        }
        let UploadClassification {
            acknowledged,
            dead_letter,
            retryable,
            ..
        } = classification;

        // Finalize each group independently so one bad message
        // cannot block the rest of the batch.
        if let Err(e) = self.store.acknowledge_uploaded(&acknowledged) {
            error!("Failed to persist upload acknowledgement: {}", e);
            return;
        }
        if let Err(e) = self
            .store
            .reject_messages(&dead_letter, "Worker permanently rejected message")
        {
            error!("Failed to persist dead-letter: {}", e);
            return;
        }
        if !retryable.is_empty() {
            let _ = self
                .store
                .return_to_pending(&retryable, "Worker returned retryable rejection");
        }
        info!(
            "☁️  Uploader: acknowledged {}, dead_letter {}, retryable {}",
            acknowledged.len(),
            dead_letter.len(),
            retryable.len()
        );
        // Reset backoff on success
        self.consecutive_failures = 0;
        self.health
            .write()
            .await
            .record_success(HealthTask::MessageUploader);
        // Small delay to avoid rate limits
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// TASK 2: DATABASE UPLOADER (Dynamic Batch Size)
/// Uploads pending messages with smart batching based on payload size
fn spawn_uploader(store: Arc<MessageStore>, client: Arc<ApiClient>, health: SharedHealth) {
    tokio::spawn(async move {
        info!("☁️  Dynamic batch uploader started - SMART SIZING with BACKOFF!");
        let mut uploader = Uploader::new(store, client, health);
        loop {
            uploader.run_cycle().await;
        }
    });
}

/// TASK 3: DEVICE STATUS SYNC (Slow Loop - every 30 seconds)
/// Reads latest device data from shared buffer (populated by Task 1) and syncs to API.
/// This avoids a second `process_modems()` call that would fight over serial ports.
fn spawn_device_sync(
    client: Arc<ApiClient>,
    devices: SharedDevices,
    modem_set: Arc<RwLock<Vec<String>>>,
    session_id: String,
) {
    let sync_manager_arc = Arc::new(tokio::sync::Mutex::new(SyncManager::new()));

    tokio::spawn(async move {
        let mut last_synced_reports = Vec::new();

        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            // Read latest modem reports from shared buffer (populated by Task 1)
            let all_reports = {
                let devices = devices.read().await;
                let mut reports: Vec<ModemReport> = devices.values().cloned().collect();
                reports.sort_by(|left, right| left.equipment_id.cmp(&right.equipment_id));
                reports
            };
            let discovered_count = modem_set.read().await.len();

            if all_reports.is_empty() && discovered_count > 0 {
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
                continue;
            }

            match client
                .upload_modem_reports(
                    &delta.reports,
                    &delta.removed_equipment_ids,
                    sync_mode,
                    &session_id,
                )
                .await
            {
                Ok(()) => {
                    info!(
                        "📊 Status sync: {} changed, {} removed (mode: {:?})",
                        delta.reports.len(),
                        delta.removed_equipment_ids.len(),
                        sync_mode
                    );
                    last_synced_reports = all_reports;
                    sync_manager.record_success(sync_mode);
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
                }
            }
        }
    });
}

/// TASK 4: STATISTICS LOGGER (every 60 seconds)
/// Logs database statistics for monitoring
fn spawn_statistics_logger(store: Arc<MessageStore>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            if let Ok(queue) = store.get_queue_stats() {
                info!(
                    "📊 Queue stats: {} pending, {} in flight, {} dead letter, oldest unacknowledged {:?}s",
                    queue.pending,
                    queue.in_flight,
                    queue.dead_letter,
                    queue.oldest_unacknowledged_age_seconds
                );
                if queue.dead_letter > 0 {
                    error!(
                        event = "message_queue_dead_letter",
                        count = queue.dead_letter,
                        "Messages require operator recovery"
                    );
                }
            }

            // Check for SIM cards with many messages
            if let Ok(full_sims) = store.check_sim_storage() {
                if !full_sims.is_empty() {
                    warn!(
                        "⚠️  SIMs with >200 messages in DB: {} cards",
                        full_sims.len()
                    );
                }
            }
        }
    });
}

/// TASK 5: ACKNOWLEDGED-ROW RETENTION (every 5 minutes)
fn spawn_retention_cleanup(store: Arc<MessageStore>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await; // Every 5 minutes

            // Uploaded rows may be retained; unacknowledged rows are never age-deleted.
            if let Ok(marked) = store.mark_old_uploaded_as_deleted() {
                if marked > 0 {
                    info!(
                        "✅ Marked {} old uploaded messages as deleted (stale paths)",
                        marked
                    );
                }
            }
        }
    });
}

/// TASK 5b: MULTIPART SEGMENTS CLEANUP (every 5 minutes)
/// Clean up incomplete multipart SMS segments older than 5 minutes
fn spawn_segment_cleanup(store: Arc<MessageStore>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await; // Every 5 minutes

            // The WAL had grown to 629 MB beside a 14 MB database; a passive
            // auto-checkpoint never caught up with the write churn.
            if let Err(e) = store.checkpoint_wal() {
                warn!("🧹 WAL checkpoint failed: {}", e);
            }

            // Clean up segments older than 5 minutes (300 seconds)
            match store.cleanup_old_segments(300) {
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
}

/// TASK 6: SMS SENDER (every 10 seconds)
/// Polls Cloudflare for pending outbound SMS and sends them via AT commands
fn spawn_sms_sender(
    api_client: ApiClient,
    modem_manager: Arc<ModemManager>,
    modem_cache: HashMap<Iccid, String>,
    session_id: String,
) {
    tokio::spawn(async move {
        info!("📤 SMS Sender task started - polling every 10 seconds");

        let mut sms_sender = SmsSender::new(api_client, modem_manager, session_id);
        sms_sender.update_modem_cache(modem_cache);

        loop {
            match sms_sender.process_pending_sms().await {
                Ok(()) => {}
                Err(e) => {
                    warn!(
                        event = "cloud_sync_failed",
                        operation = "outbound_poll",
                        error_code = "cloud_api_request_failed",
                        error = %e,
                        "Outbound SMS poll failed"
                    );
                }
            }

            // Poll every 10 seconds for pending SMS
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

/// TASK 7: INDEPENDENT HEALTH HEARTBEAT (every 60 seconds)
/// This is deliberately separate from outbound polling and device sync so one
/// healthy task cannot hide another stalled task.
fn spawn_health_heartbeat(client: Arc<ApiClient>, health: SharedHealth, store: Arc<MessageStore>) {
    tokio::spawn(async move {
        info!("💓 Independent health heartbeat started - reporting every 60 seconds");
        loop {
            let queue_stats = store.get_queue_stats().unwrap_or_default();
            let snapshot = {
                let health = health.read().await;
                let queue = health.queue_snapshot(
                    queue_stats.pending,
                    queue_stats.dead_letter,
                    queue_stats.in_flight,
                    queue_stats.oldest_unacknowledged_age_seconds,
                );
                health.snapshot(queue)
            };
            if let Err(e) = client.send_health_snapshot(&snapshot).await {
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
}

/// TASK 8: DYNAMIC MODEM RE-DISCOVERY (every 60 seconds)
/// Reconciles physical USB removal and picks up modems that enumerate after startup.
/// Newly enumerated but silent devices receive one USB reset attempt.
fn spawn_rediscovery(manager: Arc<ModemManager>, modem_set: Arc<RwLock<Vec<String>>>) {
    tokio::spawn(async move {
        info!("🔎 Modem re-discovery task started - scanning every 60 seconds");
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            match manager.reconcile_modems().await {
                Ok(current) => {
                    let mut set = modem_set.write().await;
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
}

/// TASK 9: VOICE BRIDGE (only when `VOICE_BRIDGE_DOMAIN` is set)
/// wss:// listener for the Cloudflare Realtime adapters plus one URC reader per
/// voice-capable modem for incoming calls. See docs/voice-call-plan.md.
fn spawn_voice_bridge(
    api_key: String,
    modem_manager: Arc<ModemManager>,
    api_client: ApiClient,
    devices: SharedDevices,
) {
    if let Some(voice_config) = VoiceBridgeConfig::from_env() {
        let bridge = VoiceBridge::new(api_key, modem_manager, api_client, devices);
        tokio::spawn(bridge.clone().run_urc_readers());
        tokio::spawn(async move {
            if let Err(e) = bridge.serve(voice_config).await {
                error!("📞 Voice bridge stopped: {:#}", e);
            }
        });
    } else {
        info!("📞 Voice bridge disabled (VOICE_BRIDGE_DOMAIN not set)");
    }
}

/// API URL and key from the environment, with development defaults
fn load_api_settings() -> (String, String) {
    let api_url =
        std::env::var("SMS_API_URL").unwrap_or_else(|_| "http://localhost:8787".to_string());
    let api_key = std::env::var("SMS_API_KEY").unwrap_or_else(|_| {
        warn!("SMS_API_KEY not set, using default");
        "default_api_key".to_string()
    });
    (api_url, api_key)
}

/// Fail startup when the modem backend cannot list modems
async fn check_modem_manager(modem_manager: &ModemManager) -> Result<()> {
    if let Err(e) = modem_manager.list_modems().await {
        error!("❌ ModemManager not accessible: {}", e);
        error!("💡 Make sure ModemManager is running: systemctl status ModemManager");
        return Err(anyhow::anyhow!("ModemManager not accessible"));
    }
    Ok(())
}

/// `--db-path`, else `MESSAGE_DB_PATH`, else the production default
fn resolve_db_path(args: &[String]) -> String {
    args.windows(2)
        .find_map(|w| match w {
            [flag, value] if flag == "--db-path" => Some(value.clone()),
            _ => None,
        })
        .or_else(|| std::env::var("MESSAGE_DB_PATH").ok())
        .unwrap_or_else(|| "/var/lib/sms-daemon/messages.db".to_string())
}

/// Initialize message store (SQLite database)
fn open_message_store(db_path: &str) -> Result<Arc<MessageStore>> {
    let message_store = Arc::new(MessageStore::new(db_path)?);

    // Note: Multipart SMS assembly is handled inline in modem_manager.rs
    // No separate assembler instance needed - PDU parser extracts concat info
    // and messages are assembled during the read operation

    // Mark old uploaded messages as deleted (they have stale paths)
    let marked_deleted = message_store.mark_old_uploaded_as_deleted()?;
    if marked_deleted > 0 {
        info!(
            "✅ Marked {} old uploaded messages as deleted (stale paths)",
            marked_deleted
        );
    }
    Ok(message_store)
}

/// Initialize worker pool for parallel modem processing
fn init_worker_pool(
    modem_manager: &Arc<ModemManager>,
    message_store: &Arc<MessageStore>,
) -> Arc<WorkerPool> {
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
    worker_pool
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)] // Optimized for 4-core ARM CPU
async fn main() -> Result<()> {
    logging::init()?;

    // Parse command line arguments
    let args: Vec<String> = std::env::args().collect();

    // Check for --help
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help(args.first().map_or("orange-pi-daemon", String::as_str));
        return Ok(());
    }

    let db_path = resolve_db_path(&args);

    // Check for benchmark mode
    if args.iter().any(|a| a == "benchmark") {
        info!("🏁 Running performance benchmark...");
        return PerformanceBenchmark::run_benchmark().await;
    }

    let (api_url, api_key) = load_api_settings();

    let session_id = format!("rust-daemon-{}", uuid::Uuid::new_v4());
    info!(
        "🚀 SMS Daemon v{} starting (Direct AT Commands)",
        env!("CARGO_PKG_VERSION")
    );
    info!("📡 Session ID: {}", session_id);
    info!("🌍 API URL: {}", api_url);
    info!("💾 Database: {}", db_path);

    let message_store = open_message_store(&db_path)?;

    // Initialize components
    let modem_manager = Arc::new(ModemManager::new().await);
    let config = Config {
        api_url: api_url.clone(),
        api_key: api_key.clone(),
        check_interval_secs: 1, // Fast 1-second check interval for dual-loop
    };
    let api_client = Arc::new(ApiClient::new(config)?);

    check_modem_manager(&modem_manager).await?;

    let worker_pool = init_worker_pool(&modem_manager, &message_store);

    let valid_modems = build_modem_cache(&modem_manager).await?;

    if valid_modems.is_empty() {
        error!("❌ No modems with valid IMEI found!");
        error!("💡 Check: mmcli -L");
        return Ok(());
    }

    let modem_ids: Vec<String> = valid_modems.keys().cloned().collect();

    // Live modem set, shared and mutable: the reader loop reads it each tick and the
    // re-discovery task (Task 8) reconciles additions and physical removals.
    let modem_set: Arc<RwLock<Vec<String>>> = Arc::new(RwLock::new(modem_ids));

    // Notify systemd that we're ready
    let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Ready]);
    info!("🔔 Notified systemd - daemon is ready");

    info!(
        "🚀 Starting DUAL LOOP architecture with {} modems",
        valid_modems.len()
    );

    // Shared buffer: Task 1 (modem reader) writes latest ModemReport results here,
    // Task 3 (device sync) reads from it. This avoids two pools fighting over serial ports.
    let latest_devices: SharedDevices = Arc::new(RwLock::new(HashMap::new()));
    let health_tracker: SharedHealth = Arc::new(RwLock::new(HealthTracker::new(
        session_id.clone(),
        env!("CARGO_PKG_VERSION").to_string(),
    )));

    // Beaten by the reader on every completed cycle, read by the watchdog thread.
    let reader_heartbeat = Heartbeat::default();
    spawn_modem_reader(ModemReader {
        store: message_store.clone(),
        manager: modem_manager.clone(),
        pool: worker_pool.clone(),
        modem_set: modem_set.clone(),
        devices: latest_devices.clone(),
        health: health_tracker.clone(),
        heartbeat: reader_heartbeat.clone(),
    });
    spawn_uploader(
        message_store.clone(),
        api_client.clone(),
        health_tracker.clone(),
    );
    spawn_device_sync(
        api_client.clone(),
        latest_devices.clone(),
        modem_set.clone(),
        session_id.clone(),
    );
    spawn_statistics_logger(message_store.clone());
    spawn_retention_cleanup(message_store.clone());
    spawn_segment_cleanup(message_store.clone());
    spawn_sms_sender(
        (*api_client).clone(),
        modem_manager.clone(),
        valid_modems
            .iter()
            .filter_map(|(modem_id, iccid)| iccid.as_ref().map(|i| (i.clone(), modem_id.clone())))
            .collect(),
        session_id,
    );
    spawn_health_heartbeat(api_client.clone(), health_tracker, message_store);
    spawn_rediscovery(modem_manager.clone(), modem_set);
    spawn_voice_bridge(
        api_key,
        modem_manager,
        (*api_client).clone(),
        latest_devices,
    );

    // STALL WATCHDOG — an OS thread, deliberately not a tokio task.
    // A hung daemon is worse than a dead one. On 2026-09-18 and again on
    // 2026-09-20 every runtime worker ended up spinning, so collection and
    // heartbeats stopped while the process stayed alive and Restart=always never
    // fired. The first watchdog was a task on that same runtime and was starved
    // with everything else; this one needs nothing from it.
    stall_watchdog::spawn(reader_heartbeat).context("failed to start the stall watchdog thread")?;
    info!(
        "🐕 Stall watchdog thread started - restarting if no read cycle completes for {}s",
        STALL_AFTER.as_secs()
    );

    // Main thread just monitors health
    info!("✨ All tasks spawned - system running in dual-loop mode");
    loop {
        tokio::time::sleep(Duration::from_secs(300)).await;
        info!("💓 Heartbeat - daemon is healthy");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orange_pi_daemon_rust::identifiers::SmsAddress;
    use orange_pi_daemon_rust::message_store::MessageStatus;
    use orange_pi_daemon_rust::types::{Direction, Message};

    fn stored(source_message_id: &str) -> StoredMessage {
        StoredMessage {
            id: 1,
            source_message_id: source_message_id.to_string(),
            message: Message {
                phone_iccid: Iccid::try_from("89860000000000000001").unwrap(),
                phone_number: SmsAddress::from("10010"),
                content: "content".to_string(),
                timestamp: "2026-01-01T00:00:00.000Z".to_string(),
                direction: Direction::Received,
            },
            modem_id: "1".to_string(),
            sms_path: "at:ME:1".to_string(),
            status: MessageStatus::InFlight,
            attempts: 1,
            lease_token: "lease".to_string(),
        }
    }

    fn result(id: &str, status: UploadStatus, retryable: bool) -> UploadResult {
        UploadResult {
            id: id.to_string(),
            status,
            retryable,
        }
    }

    #[test]
    fn upload_results_are_sorted_by_status_and_retryability() {
        let pending = [
            stored("stored"),
            stored("already"),
            stored("dead"),
            stored("retry"),
            stored("unknown"),
        ];
        let classification = classify_upload_results(
            &pending,
            &[
                result("stored", UploadStatus::Stored, false),
                result("already", UploadStatus::AlreadyStored, false),
                result("dead", UploadStatus::Rejected, false),
                result("retry", UploadStatus::Rejected, true),
                result(
                    "unknown",
                    UploadStatus::Unknown("throttled".to_string()),
                    false,
                ),
                result("missing", UploadStatus::Stored, false),
            ],
        );
        let ids = |messages: &[StoredMessage]| -> Vec<String> {
            messages
                .iter()
                .map(|m| m.source_message_id.clone())
                .collect()
        };
        assert_eq!(ids(&classification.acknowledged), ["stored", "already"]);
        assert_eq!(ids(&classification.dead_letter), ["dead"]);
        assert_eq!(ids(&classification.retryable), ["retry", "unknown"]);
        assert_eq!(classification.unknown_ids, ["missing"]);
    }
}
