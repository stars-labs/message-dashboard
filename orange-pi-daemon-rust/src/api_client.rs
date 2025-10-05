use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::json;
use crate::types::*;
use tracing::{info, warn};

pub struct ApiClient {
    client: Client,
    config: Config,
}

impl ApiClient {
    pub fn new(config: Config) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("Failed to create HTTP client"),
            config,
        }
    }
    
    /// Upload phone status data
    pub async fn upload_phones(&self, phones: &[Phone]) -> Result<()> {
        if phones.is_empty() {
            return Ok(());
        }
        
        let url = format!("{}/api/control/phones", self.config.api_url);
        
        let response = self.client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .json(&json!({ "phones": phones }))
            .send()
            .await
            .context("Failed to send phone data")?;
        
        if !response.status().is_success() {
            anyhow::bail!("API returned error: {}", response.status());
        }
        
        info!("✅ Uploaded {} phone records", phones.len());
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
