use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use orange_pi_daemon_rust::health::HealthTask;
use orange_pi_daemon_rust::message_store::MessageStore;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::stall_watchdog::Heartbeat;
use orange_pi_daemon_rust::sync_manager::merge_device_reports;
use orange_pi_daemon_rust::timeout_tracker::TimeoutTracker;
use orange_pi_daemon_rust::types::MessageWithPath;
use orange_pi_daemon_rust::wire::ModemReport;
use orange_pi_daemon_rust::worker_pool::{ModemResult, WorkerPool};

use crate::{SharedDevices, SharedHealth};

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
    match store.store_message(
        &msg_with_path.message,
        &msg_with_path.modem_id,
        &msg_with_path.sms_path,
    ) {
        Ok(true) => {
            counts.stored += 1;

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
            // The SIM copy must still be deleted: a reset between "stored" and
            // "deleted" would otherwise leave it to be re-read on every scan,
            // and a full SIM makes the carrier drop new SMS.
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
        // Rediscovery never touches a cached modem, so a wedged one must be
        // forgotten for the next reconcile to probe its USB device again.
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

pub(crate) struct ModemReader {
    pub(crate) store: Arc<MessageStore>,
    pub(crate) manager: Arc<ModemManager>,
    pub(crate) pool: Arc<WorkerPool>,
    pub(crate) modem_set: Arc<RwLock<Vec<String>>>,
    pub(crate) devices: SharedDevices,
    pub(crate) health: SharedHealth,
    pub(crate) heartbeat: Heartbeat,
}

pub(crate) fn spawn_modem_reader(reader: ModemReader) {
    tokio::spawn(async move {
        let mut timeouts = TimeoutTracker::default();
        loop {
            let start = Instant::now();

            let current_ids = reader.modem_set.read().await.clone();

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

            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}
