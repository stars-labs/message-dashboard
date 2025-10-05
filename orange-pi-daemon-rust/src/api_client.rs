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
    
    /// Upload phone status data (converts to normalized modem/SIM structure)
    pub async fn upload_phones(&self, phones: &[Phone]) -> Result<()> {
        if phones.is_empty() {
            return Ok(());
        }
        
        // Convert phones to normalized modem/SIM structure
        let mut modems = Vec::new();
        let mut sims = Vec::new();
        
        for phone in phones {
            let (modem, sim) = phone.clone().into_normalized();
            modems.push(modem);
            sims.push(sim);
        }
        
        let url = format!("{}/api/control/devices", self.config.api_url);
        
        let response = self.client
            .post(&url)
            .header("x-api-key", &self.config.api_key)
            .json(&json!({ 
                "sync_mode": "incremental",
                "modems": modems,
                "sims": sims
            }))
            .send()
            .await
            .context("Failed to send device data")?;
        
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_else(|_| String::from("(no body)"));
            anyhow::bail!("API returned error: {} - {}", status, body);
        }
        
        info!("✅ Uploaded {} modems and {} SIMs", modems.len(), sims.len());
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
