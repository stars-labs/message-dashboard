use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::health::HealthTask;
use orange_pi_daemon_rust::message_store::{MessageStore, StoredMessage};
use orange_pi_daemon_rust::wire::{UploadResult, UploadStatus};

use crate::SharedHealth;

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
    batch_size: usize,
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
        if self.consecutive_failures > 0 {
            let backoff_secs =
                (2u64.pow(self.consecutive_failures.min(6))).min(Self::MAX_BACKOFF_SECS);
            warn!(
                "☁️  Backoff: waiting {}s after {} consecutive failures",
                backoff_secs, self.consecutive_failures
            );
            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        }

        match self.store.claim_messages(self.batch_size, 90) {
            Ok(pending) if !pending.is_empty() => self.upload_batch(pending).await,
            Ok(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                warn!("☁️  Uploader: Failed to read local queue: {}", e);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }

    async fn upload_batch(&mut self, pending: Vec<StoredMessage>) {
        let payload_size: usize = pending
            .iter()
            .map(|m| m.message.content.len() + m.message.phone_number.as_str().len() + 100) // +100 for JSON overhead
            .sum();

        if payload_size < 100_000
            && pending.len() == self.batch_size
            && self.consecutive_failures == 0
        {
            self.batch_size = (self.batch_size * 2).min(100);
        } else if payload_size > 500_000 || self.consecutive_failures > 2 {
            self.batch_size = (self.batch_size / 2).max(10);
        }

        info!(
            "☁️  Uploading {} messages (~{} KB)",
            pending.len(),
            payload_size / 1024
        );

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
                let _ = self.store.return_to_pending(&pending, &e.to_string());
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            }
        }
    }

    async fn finish_upload(&mut self, pending: &[StoredMessage], results: &[UploadResult]) {
        let classification = classify_upload_results(pending, results);
        for id in &classification.unknown_ids {
            // An ID we never sent is a Worker bug; retry the whole batch.
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
        self.consecutive_failures = 0;
        self.health
            .write()
            .await
            .record_success(HealthTask::MessageUploader);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub(crate) fn spawn_uploader(
    store: Arc<MessageStore>,
    client: Arc<ApiClient>,
    health: SharedHealth,
) {
    tokio::spawn(async move {
        info!("☁️  Dynamic batch uploader started - SMART SIZING with BACKOFF!");
        let mut uploader = Uploader::new(store, client, health);
        loop {
            uploader.run_cycle().await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use orange_pi_daemon_rust::identifiers::{Iccid, SmsAddress};
    use orange_pi_daemon_rust::types::Message;
    use orange_pi_daemon_rust::wire::Direction;

    fn stored(source_message_id: &str) -> StoredMessage {
        StoredMessage {
            source_message_id: source_message_id.to_string(),
            message: Message {
                phone_iccid: Iccid::try_from("89860000000000000001").unwrap(),
                phone_number: SmsAddress::from("10010"),
                content: "content".to_string(),
                timestamp: "2026-01-01T00:00:00.000Z".to_string(),
                direction: Direction::Received,
            },
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

    fn source_ids(messages: &[StoredMessage]) -> Vec<&str> {
        messages
            .iter()
            .map(|m| m.source_message_id.as_str())
            .collect()
    }

    #[test]
    fn no_results_leave_every_pending_message_unclassified() {
        let classification = classify_upload_results(&[stored("a"), stored("b")], &[]);

        assert!(classification.acknowledged.is_empty());
        assert!(classification.dead_letter.is_empty());
        assert!(classification.retryable.is_empty());
        assert!(classification.unknown_ids.is_empty());
    }

    #[test]
    fn results_for_an_empty_batch_are_all_unknown_ids() {
        let classification = classify_upload_results(
            &[],
            &[
                result("x", UploadStatus::Stored, false),
                result("y", UploadStatus::Rejected, true),
            ],
        );

        assert_eq!(classification.unknown_ids, ["x", "y"]);
        assert!(classification.acknowledged.is_empty());
        assert!(classification.retryable.is_empty());
    }

    #[test]
    fn the_retryable_flag_does_not_change_an_acknowledged_result() {
        let classification = classify_upload_results(
            &[stored("a"), stored("b")],
            &[
                result("a", UploadStatus::Stored, true),
                result("b", UploadStatus::AlreadyStored, true),
            ],
        );

        assert_eq!(source_ids(&classification.acknowledged), ["a", "b"]);
        assert!(classification.retryable.is_empty());
    }

    #[test]
    fn an_unknown_status_is_retried_whatever_its_retryable_flag() {
        let classification = classify_upload_results(
            &[stored("a"), stored("b")],
            &[
                result("a", UploadStatus::Unknown("new".to_string()), true),
                result("b", UploadStatus::Unknown("new".to_string()), false),
            ],
        );

        assert_eq!(source_ids(&classification.retryable), ["a", "b"]);
        assert!(classification.dead_letter.is_empty());
    }

    #[test]
    fn results_keep_the_order_the_worker_answered_in() {
        let classification = classify_upload_results(
            &[stored("a"), stored("b"), stored("c")],
            &[
                result("c", UploadStatus::Stored, false),
                result("a", UploadStatus::Stored, false),
                result("b", UploadStatus::Stored, false),
            ],
        );

        assert_eq!(source_ids(&classification.acknowledged), ["c", "a", "b"]);
    }

    #[test]
    fn a_pending_message_without_a_result_is_in_no_bucket() {
        let classification = classify_upload_results(
            &[stored("answered"), stored("silent")],
            &[result("answered", UploadStatus::Stored, false)],
        );

        assert_eq!(source_ids(&classification.acknowledged), ["answered"]);
        assert!(classification.dead_letter.is_empty());
        assert!(classification.retryable.is_empty());
        assert!(classification.unknown_ids.is_empty());
    }
}
