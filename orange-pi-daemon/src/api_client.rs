use crate::identifiers::{Iccid, Imei};
use crate::message_store::StoredMessage;
use crate::types::Config;
use crate::wire::{
    CallEndReason, EndedCallRequest, HealthSnapshot, IncomingCallRequest, MessageBatchRequest,
    ModemReport, ModemReportsRequest, PendingSms, PendingSmsResponse, SyncMode, UploadResponse,
    UploadResult, UploadedMessage,
};
use anyhow::{Context, Result};
use reqwest::Client;
use serde::Serialize;
use tracing::info;

impl<'a> From<&'a StoredMessage> for UploadedMessage<'a> {
    fn from(stored: &'a StoredMessage) -> Self {
        Self {
            content: &stored.message.content,
            direction: &stored.message.direction,
            id: &stored.source_message_id,
            phone_iccid: &stored.message.phone_iccid,
            phone_number: &stored.message.phone_number,
            timestamp: &stored.message.timestamp,
        }
    }
}

#[derive(Clone)]
pub struct ApiClient {
    client: Client,
    pub config: Config,
}

impl ApiClient {
    pub fn new(config: Config) -> Result<Self> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30)) // Increased to 30s for large uploads
            .build()
            .context("Failed to create HTTP client")?;
        Ok(Self { client, config })
    }

    /// Send an independent, versioned process and task health report.
    pub async fn send_health_snapshot(&self, snapshot: &HealthSnapshot) -> Result<()> {
        let url = format!("{}/api/control/heartbeat", self.config.api_url);
        let response = self
            .client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .header("x-daemon-version", env!("CARGO_PKG_VERSION"))
            .json(snapshot)
            .send()
            .await
            .context("Failed to send health snapshot")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Health endpoint returned {status}: {body}");
        }

        Ok(())
    }

    /// Upload changed modem reports and explicit removals.
    pub async fn upload_modem_reports(
        &self,
        reports: &[ModemReport],
        removed_equipment_ids: &[Imei],
        sync_mode: SyncMode,
        session_id: &str,
    ) -> Result<()> {
        if sync_mode == SyncMode::Incremental
            && reports.is_empty()
            && removed_equipment_ids.is_empty()
        {
            return Ok(());
        }

        let url = format!("{}/api/control/devices", self.config.api_url);
        let timestamp = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        info!(
            "📤 Uploading {} changed modem reports and {} removals (mode: {}, session: {})",
            reports.len(),
            removed_equipment_ids.len(),
            sync_mode.as_str(),
            session_id
        );

        let payload = ModemReportsRequest {
            modem_reports: reports,
            removed_equipment_ids,
            session_id,
            sync_mode,
            timestamp: &timestamp,
        };

        let response = self
            .client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .header("x-daemon-version", "rust-3.0.0-reports")
            .json(&payload)
            .send()
            .await
            .context("Failed to send modem reports")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| String::from("(no body)"));
            anyhow::bail!("API returned error: {status} - {body}");
        }

        info!(
            "✅ Successfully uploaded modem reports (mode: {})",
            sync_mode.as_str()
        );
        Ok(())
    }

    /// Upload messages with proper batching to avoid overwhelming the API
    pub async fn upload_messages(&self, messages: &[StoredMessage]) -> Result<Vec<UploadResult>> {
        const BATCH_SIZE: usize = 50; // Match the server's internal batch size

        if messages.is_empty() {
            return Ok(vec![]);
        }

        let url = format!("{}/api/control/messages", self.config.api_url);

        // Process messages in batches to avoid overwhelming the API
        let total = messages.len();
        let mut results = Vec::with_capacity(messages.len());

        for (batch_num, chunk) in messages.chunks(BATCH_SIZE).enumerate() {
            info!(
                "📤 Uploading batch {}/{} ({} messages)",
                batch_num + 1,
                total.div_ceil(BATCH_SIZE),
                chunk.len()
            );

            // Upload this batch
            let response = self
                .client
                .post(&url)
                .header("x-api-key", &self.config.api_key)
                .json(&MessageBatchRequest {
                    messages: chunk.iter().map(UploadedMessage::from).collect(),
                })
                .send()
                .await
                .context(format!("Failed to upload message batch {}", batch_num + 1))?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response
                    .text()
                    .await
                    .unwrap_or_else(|_| String::from("(no body)"));
                anyhow::bail!(
                    "API returned error for batch {}: {} - {}",
                    batch_num + 1,
                    status,
                    body
                );
            }

            let response: UploadResponse = response
                .json()
                .await
                .context("Invalid message upload response")?;
            results.extend(response.results);

            // Small delay between batches to avoid rate limiting
            if batch_num < messages.chunks(BATCH_SIZE).len() - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }

        info!(
            "✅ Successfully uploaded {} messages in {} batches",
            results.len(),
            total.div_ceil(BATCH_SIZE)
        );
        Ok(results)
    }

    /// Get pending SMS to send
    pub async fn get_pending_sms(&self) -> Result<Vec<PendingSms>> {
        let url = format!("{}/api/control/pending-sms", self.config.api_url);

        let response = self
            .client
            .get(&url)
            .header("x-api-key", &self.config.api_key)
            .send()
            .await
            .context("Failed to get pending SMS")?;

        if !response.status().is_success() {
            anyhow::bail!("API returned error: {}", response.status());
        }

        let data: PendingSmsResponse = response.json().await?;
        Ok(data.pending_messages)
    }

    /// Report a ringing SIM. Repeated while it rings; the Worker refreshes a
    /// short-lived KV entry and answers 409 when another call is active.
    pub async fn report_incoming_call(&self, iccid: &Iccid, from: Option<&str>) -> Result<()> {
        self.post_call_event("incoming", &IncomingCallRequest { from, iccid })
            .await
    }

    /// Report that a call ended on the modem side: hangup, failure, or a ring
    /// that stopped. `call_id` is absent for an unanswered ring.
    pub async fn report_call_ended(
        &self,
        call_id: Option<&str>,
        iccid: &Iccid,
        reason: CallEndReason,
    ) -> Result<()> {
        self.post_call_event(
            "ended",
            &EndedCallRequest {
                call_id,
                iccid,
                reason,
            },
        )
        .await
    }

    async fn post_call_event(&self, event: &str, body: &impl Serialize) -> Result<()> {
        let url = format!("{}/api/control/calls/{}", self.config.api_url, event);
        let response = self
            .client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .timeout(std::time::Duration::from_secs(10))
            .json(body)
            .send()
            .await
            .with_context(|| format!("Failed to report call {event}"))?;
        let status = response.status();
        // 409: another call holds the single-call lock, which is expected.
        if !status.is_success() && status != reqwest::StatusCode::CONFLICT {
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("calls/{event} returned {status}: {body}");
        }
        Ok(())
    }
}
