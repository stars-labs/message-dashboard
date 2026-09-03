use crate::health::HealthSnapshot;
use crate::sync_manager::SyncMode;
use crate::types::*;
use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::json;
use tracing::info;

#[derive(Clone)]
pub struct ApiClient {
    client: Client,
    pub config: Config,
}

impl ApiClient {
    pub fn new(config: Config) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30)) // Increased to 30s for large uploads
                .build()
                .expect("Failed to create HTTP client"),
            config,
        }
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
            anyhow::bail!("Health endpoint returned {}: {}", status, body);
        }

        Ok(())
    }

    /// Upload changed modem reports and explicit removals.
    pub async fn upload_modem_reports(
        &self,
        reports: &[ModemReport],
        removed_equipment_ids: &[String],
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

        let payload = json!({
            "sync_mode": sync_mode.as_str(),
            "session_id": session_id,
            "timestamp": timestamp,
            "modem_reports": reports,
            "removed_equipment_ids": removed_equipment_ids,
        });

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
            anyhow::bail!("API returned error: {} - {}", status, body);
        }

        info!(
            "✅ Successfully uploaded modem reports (mode: {})",
            sync_mode.as_str()
        );
        Ok(())
    }

    /// Upload messages with proper batching to avoid overwhelming the API
    pub async fn upload_messages(&self, messages: &[Message]) -> Result<()> {
        if messages.is_empty() {
            return Ok(());
        }

        const BATCH_SIZE: usize = 50; // Match the server's internal batch size
        let url = format!("{}/api/control/messages", self.config.api_url);

        // Process messages in batches to avoid overwhelming the API
        let total = messages.len();
        let mut uploaded = 0;

        for (batch_num, chunk) in messages.chunks(BATCH_SIZE).enumerate() {
            info!(
                "📤 Uploading batch {}/{} ({} messages)",
                batch_num + 1,
                (total + BATCH_SIZE - 1) / BATCH_SIZE,
                chunk.len()
            );

            // Upload this batch
            let response = self
                .client
                .post(&url)
                .header("x-api-key", &self.config.api_key)
                .json(&json!({ "messages": chunk }))
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

            uploaded += chunk.len();

            // Small delay between batches to avoid rate limiting
            if batch_num < messages.chunks(BATCH_SIZE).len() - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }

        info!(
            "✅ Successfully uploaded {} messages in {} batches",
            uploaded,
            (total + BATCH_SIZE - 1) / BATCH_SIZE
        );
        Ok(())
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

        #[derive(serde::Deserialize)]
        struct PendingResponse {
            pending_messages: Vec<PendingSms>,
        }

        let data: PendingResponse = response.json().await?;
        Ok(data.pending_messages)
    }
}
