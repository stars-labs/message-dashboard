use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingSms {
    pub id: String,
    pub recipient: String,
    pub phone_iccid: String,
    pub content: String,
    #[serde(default = "default_sms_purpose")]
    pub purpose: String,
    pub created_at: String,
}

fn default_sms_purpose() -> String {
    "user".to_string()
}

#[derive(Debug, Serialize)]
struct SmsResult {
    message_id: String,
    success: bool,
    error_message: Option<String>,
}

pub struct SmsSender {
    api_client: crate::api_client::ApiClient,
    modem_manager: Arc<crate::modem_manager::ModemManager>,
    modem_cache: HashMap<String, String>, // ICCID -> modem_id mapping
}

impl SmsSender {
    pub fn new(
        api_client: crate::api_client::ApiClient,
        modem_manager: Arc<crate::modem_manager::ModemManager>,
    ) -> Self {
        Self {
            api_client,
            modem_manager,
            modem_cache: HashMap::new(),
        }
    }

    /// Update the modem cache with current ICCID mappings
    pub fn update_modem_cache(&mut self, cache: HashMap<String, String>) {
        self.modem_cache = cache;
    }

    /// Fetch pending SMS messages from the API
    pub async fn get_pending_sms(&self) -> Result<Vec<PendingSms>> {
        let url = format!("{}/api/control/pending-sms", self.api_client.config.api_url);

        debug!("🌐 Fetching pending SMS from: {}", url);

        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .header("X-API-Key", &self.api_client.config.api_key)
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "Failed to fetch pending SMS: {} - {}",
                status,
                text
            ));
        }

        #[derive(Deserialize)]
        struct ApiResponse {
            pending_messages: Vec<PendingSms>,
        }

        let api_response: ApiResponse = response.json().await?;

        if !api_response.pending_messages.is_empty() {
            info!(
                "📱 Found {} pending SMS messages to send",
                api_response.pending_messages.len()
            );
        }

        Ok(api_response.pending_messages)
    }

    /// Find modem ID for a given ICCID using cache or D-Bus
    pub async fn find_modem_for_iccid(&self, target_iccid: &str) -> Option<String> {
        debug!("🔍 Searching for modem with ICCID: {}", target_iccid);

        // First check our cache
        if let Some(modem_id) = self.modem_cache.get(target_iccid) {
            debug!(
                "✅ Found modem {} in cache for ICCID {}",
                modem_id, target_iccid
            );
            return Some(modem_id.clone());
        }

        // If not in cache, search through all modems via D-Bus
        info!(
            "📱 ICCID {} not in cache, searching via D-Bus...",
            target_iccid
        );

        // List all modems using D-Bus
        let modem_ids = match self.modem_manager.list_modems().await {
            Ok(ids) => ids,
            Err(e) => {
                error!("❌ Failed to list modems via D-Bus: {}", e);
                return None;
            }
        };

        debug!("📱 Found {} modems to check", modem_ids.len());

        // Check each modem for matching ICCID
        for modem_id in modem_ids {
            match self.modem_manager.get_iccid(&modem_id).await {
                Ok(Some(iccid)) => {
                    debug!(
                        "📱 Modem {} has ICCID: {} (target: {})",
                        modem_id, iccid, target_iccid
                    );

                    if iccid == target_iccid {
                        info!("✅ Found modem {} for ICCID {}", modem_id, target_iccid);
                        return Some(modem_id);
                    }
                }
                Ok(None) => {
                    debug!("📱 Modem {} has no SIM", modem_id);
                }
                Err(e) => {
                    debug!("⚠️  Failed to get ICCID for modem {}: {}", modem_id, e);
                }
            }
        }

        error!("❌ No modem found with ICCID {}", target_iccid);
        None
    }

    /// Send an SMS message using ModemManager (AT commands or D-Bus)
    pub async fn send_sms(&self, sms: &PendingSms) -> Result<()> {
        // Find the modem for this ICCID
        let modem_id = match self.find_modem_for_iccid(&sms.phone_iccid).await {
            Some(id) => id,
            None => {
                error!("No modem found for ICCID: {}", sms.phone_iccid);
                let _ = self
                    .report_sms_result(&sms.id, false, Some("No modem found for ICCID"))
                    .await;
                return Err(anyhow!("ModemNotFound"));
            }
        };

        info!(
            "📤 Sending SMS from modem {} to {}",
            modem_id, sms.recipient
        );

        // Send SMS using ModemManager (supports both AT commands and D-Bus)
        match self
            .modem_manager
            .send_sms_with_short_code(
                &modem_id,
                &sms.recipient,
                &sms.content,
                sms.purpose == "balance_maintenance",
            )
            .await
        {
            Ok(_) => {
                // Report success
                self.report_sms_result(&sms.id, true, None).await?;
                info!(
                    "✅ SMS sent successfully to {} (Message ID: {})",
                    sms.recipient, sms.id
                );
                Ok(())
            }
            Err(e) => {
                let error_msg = format!("Failed to send SMS: {}", e);
                error!("{}", error_msg);
                self.report_sms_result(&sms.id, false, Some(&error_msg))
                    .await?;
                Err(anyhow!(error_msg))
            }
        }
    }

    /// Report SMS result back to API
    pub async fn report_sms_result(
        &self,
        message_id: &str,
        success: bool,
        error_message: Option<&str>,
    ) -> Result<()> {
        let url = format!("{}/api/control/sms-result", self.api_client.config.api_url);

        let result = SmsResult {
            message_id: message_id.to_string(),
            success,
            error_message: error_message.map(|s| s.to_string()),
        };

        debug!(
            "📤 Reporting SMS result for {}: success={}",
            message_id, success
        );

        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-API-Key", &self.api_client.config.api_key)
            .json(&result)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            warn!("Failed to report SMS result: {} - {}", status, text);
            return Err(anyhow!(
                "Failed to report SMS result: {} - {}",
                status,
                text
            ));
        }

        if success {
            debug!("✅ Marked SMS {} as sent", message_id);
        } else {
            debug!("⚠️  Marked SMS {} as failed", message_id);
        }

        Ok(())
    }

    /// Process all pending SMS messages
    pub async fn process_pending_sms(&self) -> Result<()> {
        let pending_messages = self.get_pending_sms().await?;

        if pending_messages.is_empty() {
            return Ok(());
        }

        info!(
            "📤 Processing {} pending SMS messages",
            pending_messages.len()
        );

        for sms in pending_messages {
            match self.send_sms(&sms).await {
                Ok(_) => {
                    info!("✅ Successfully sent SMS to {}", sms.recipient);
                }
                Err(e) => {
                    error!("❌ Failed to send SMS to {}: {}", sms.recipient, e);
                    // Continue with next message even if this one failed
                }
            }
        }

        Ok(())
    }
}
