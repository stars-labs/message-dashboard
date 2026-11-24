use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::identifiers::Iccid;
use orange_pi_daemon_rust::message_store::MessageStore;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::sms_sender::SmsSender;
use orange_pi_daemon_rust::sync_manager::{device_delta, DeviceDelta, SyncManager};
use orange_pi_daemon_rust::types::ApiKey;
use orange_pi_daemon_rust::voice_bridge::{VoiceBridge, VoiceBridgeConfig};
use orange_pi_daemon_rust::wire::{ModemReport, SyncMode};

use crate::{SharedDevices, SharedHealth};

/// Syncs the reader's latest reports instead of calling `process_modems()` again,
/// which would fight the reader over serial ports.
pub(crate) fn spawn_device_sync(
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

pub(crate) fn spawn_statistics_logger(store: Arc<MessageStore>) {
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

pub(crate) fn spawn_retention_cleanup(store: Arc<MessageStore>) {
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

pub(crate) fn spawn_segment_cleanup(store: Arc<MessageStore>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await; // Every 5 minutes

            // Passive auto-checkpoint does not keep up with the write churn.
            if let Err(e) = store.checkpoint_wal() {
                warn!("🧹 WAL checkpoint failed: {}", e);
            }

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

pub(crate) fn spawn_sms_sender(
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

            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

/// Separate from outbound polling and device sync so one healthy task cannot
/// hide another stalled task.
pub(crate) fn spawn_health_heartbeat(
    client: Arc<ApiClient>,
    health: SharedHealth,
    store: Arc<MessageStore>,
) {
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

/// Reconciles physical USB removal and picks up modems that enumerate after startup.
/// Newly enumerated but silent devices receive one USB reset attempt.
pub(crate) fn spawn_rediscovery(manager: Arc<ModemManager>, modem_set: Arc<RwLock<Vec<String>>>) {
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

/// Runs only when `VOICE_BRIDGE_DOMAIN` is set: a wss:// listener for the Cloudflare Realtime adapters plus one URC reader per
/// voice-capable modem for incoming calls. See docs/voice-call-plan.md.
pub(crate) fn spawn_voice_bridge(
    api_key: ApiKey,
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
