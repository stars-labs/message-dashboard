use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::json;
use crate::types::*;
use crate::sync_manager::SyncMode;
use tracing::{info, warn};

pub struct ApiClient {
    client: Client,
    config: Config,
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
    
    /// Upload devices using normalized schema with sync mode
    /// This is the NEW preferred method matching Zig daemon architecture
    pub async fn upload_devices(
        &self,
        modems: &[Modem],
        sims: &[Sim],
        sync_mode: SyncMode,
        session_id: &str,
    ) -> Result<()> {
        if modems.is_empty() && sims.is_empty() {
            warn!("⚠️  Attempted to upload empty device list");
            return Ok(());
        }

        let url = format!("{}/api/control/devices", self.config.api_url);
        let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

        info!(
            "📤 Uploading {} modems and {} SIMs (mode: {}, session: {})",
            modems.len(),
            sims.len(),
            sync_mode.as_str(),
            session_id
        );

        let payload = json!({
            "sync_mode": sync_mode.as_str(),
            "session_id": session_id,
            "timestamp": timestamp,
            "modems": modems,
            "sims": sims,
        });

        let response = self.client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .header("x-daemon-version", "rust-2.0.0-sync")
            .json(&payload)
            .send()
            .await
            .context("Failed to send device data")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_else(|_| String::from("(no body)"));
            anyhow::bail!("API returned error: {} - {}", status, body);
        }

        info!("✅ Successfully uploaded devices (mode: {})", sync_mode.as_str());
        Ok(())
    }

    /// Upload phone status data (LEGACY - use upload_devices instead)
    /// Kept for backward compatibility only
    #[deprecated(note = "Use upload_devices instead")]
    pub async fn upload_phones(&self, phones: &[Phone]) -> Result<()> {
        if phones.is_empty() {
            return Ok(());
        }

        warn!("⚠️  Using deprecated upload_phones - should migrate to upload_devices");

        // Use the legacy /api/control/phones endpoint which expects { phones: [...] }
        let url = format!("{}/api/control/phones", self.config.api_url);

        let response = self.client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .header("x-daemon-version", "rust-1.0.0")
            .json(&json!({ "phones": phones }))
            .send()
            .await
            .context("Failed to send phone data")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_else(|_| String::from("(no body)"));
            anyhow::bail!("API returned error: {} - {}", status, body);
        }

        info!("✅ Uploaded {} phones", phones.len());
        Ok(())
    }
    
    /// Upload messages
    pub async fn upload_messages(&self, messages: &[Message]) -> Result<()> {
        if messages.is_empty() {
            return Ok(());
        }
        
        let url = format!("{}/api/control/messages", self.config.api_url);
        
        // Upload messages in batch
        let response = self.client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .json(&json!({ "messages": messages }))
            .send()
            .await
            .context("Failed to upload messages")?;
        
        if !response.status().is_success() {
            anyhow::bail!("API returned error: {}", response.status());
        }
        
        info!("✅ Uploaded {} messages", messages.len());
        Ok(())
    }
    
    /// Get pending SMS to send
    pub async fn get_pending_sms(&self) -> Result<Vec<PendingSms>> {
        let url = format!("{}/api/control/pending-sms", self.config.api_url);
        
        let response = self.client
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
