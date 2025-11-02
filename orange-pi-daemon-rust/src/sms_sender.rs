use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::process::Command;
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingSms {
    pub id: String,
    pub recipient: String,
    pub phone_iccid: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
struct SmsResult {
    message_id: String,
    success: bool,
    error_message: Option<String>,
}

pub struct SmsSender {
    api_client: crate::api_client::ApiClient,
    modem_cache: HashMap<String, String>, // ICCID -> modem_id mapping
}

impl SmsSender {
    pub fn new(api_client: crate::api_client::ApiClient) -> Self {
        Self {
            api_client,
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
            return Err(anyhow!("Failed to fetch pending SMS: {} - {}", status, text));
        }

        #[derive(Deserialize)]
        struct ApiResponse {
            pending_messages: Vec<PendingSms>,
        }

        let api_response: ApiResponse = response.json().await?;

        if !api_response.pending_messages.is_empty() {
            info!("📱 Found {} pending SMS messages to send", api_response.pending_messages.len());
        }

        Ok(api_response.pending_messages)
    }

    /// Find modem ID for a given ICCID
    pub async fn find_modem_for_iccid(&self, target_iccid: &str) -> Option<String> {
        debug!("🔍 Searching for modem with ICCID: {}", target_iccid);

        // First check our cache
        if let Some(modem_id) = self.modem_cache.get(target_iccid) {
            debug!("✅ Found modem {} in cache for ICCID {}", modem_id, target_iccid);
            return Some(modem_id.clone());
        }

        // If not in cache, try to find it via mmcli
        info!("📱 ICCID {} not in cache, searching via mmcli...", target_iccid);

        // List all modems
        let output = Command::new("mmcli")
            .arg("-L")
            .output()
            .await
            .ok()?;

        if !output.status.success() {
            warn!("⚠️  Failed to list modems via mmcli");
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let modem_ids: Vec<String> = stdout
            .lines()
            .filter_map(|line| {
                if let Some(pos) = line.find("/Modem/") {
                    let id_start = pos + 7;
                    let id = line[id_start..]
                        .split_whitespace()
                        .next()?
                        .to_string();
                    Some(id)
                } else {
                    None
                }
            })
            .collect();

        debug!("📱 Found {} modems to check", modem_ids.len());

        // Check each modem for matching ICCID
        for modem_id in modem_ids {
            // Get SIM info
            let output = Command::new("mmcli")
                .arg("-m")
                .arg(&modem_id)
                .output()
                .await
                .ok()?;

            if !output.status.success() {
                continue;
            }

            let stdout = String::from_utf8_lossy(&output.stdout);

            // Extract SIM path and get ICCID
            if let Some(sim_line) = stdout.lines().find(|l| l.contains("primary sim path:")) {
                if let Some(sim_path) = sim_line.split(':').nth(1) {
                    let sim_path = sim_path.trim();

                    // Get SIM details
                    let output = Command::new("mmcli")
                        .arg("-i")
                        .arg(sim_path)
                        .output()
                        .await
                        .ok()?;

                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);

                        // Extract ICCID
                        if let Some(iccid_line) = stdout.lines().find(|l| l.contains("iccid:")) {
                            if let Some(iccid) = iccid_line.split(':').nth(1) {
                                let iccid = iccid.trim().trim_matches('\'');

                                debug!("📱 Modem {} has ICCID: {} (target: {})", modem_id, iccid, target_iccid);

                                if iccid == target_iccid {
                                    info!("✅ Found modem {} for ICCID {}", modem_id, target_iccid);
                                    return Some(modem_id);
                                }
                            }
                        }
                    }
                }
            }
        }

        error!("❌ No modem found with ICCID {}", target_iccid);
        None
    }

    /// Send an SMS message
    pub async fn send_sms(&self, sms: &PendingSms) -> Result<()> {
        // Find the modem for this ICCID
        let modem_id = match self.find_modem_for_iccid(&sms.phone_iccid).await {
            Some(id) => id,
            None => {
                error!("No modem found for ICCID: {}", sms.phone_iccid);
                let _ = self.report_sms_result(&sms.id, false, Some("No modem found for ICCID")).await;
                return Err(anyhow!("ModemNotFound"));
            }
        };

        info!("📤 Sending SMS from modem {} to {}", modem_id, sms.recipient);

        // Send the SMS using mmcli
        let output = Command::new("mmcli")
            .arg("-m")
            .arg(&modem_id)
            .arg("--messaging-create-sms")
            .arg(format!("text='{}',number='{}'", sms.content, sms.recipient))
            .output()
            .await?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            error!("Failed to create SMS: {}", error);
            self.report_sms_result(&sms.id, false, Some(&error)).await?;
            return Err(anyhow!("Failed to create SMS: {}", error));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Extract SMS path from output
        let sms_path = stdout
            .lines()
            .find(|l| l.contains("SMS"))
            .and_then(|l| l.split_whitespace().last())
            .ok_or_else(|| anyhow!("Failed to extract SMS path from mmcli output"))?;

        // Send the SMS
        let output = Command::new("mmcli")
            .arg("-s")
            .arg(sms_path)
            .arg("--send")
            .output()
            .await?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            error!("Failed to send SMS: {}", error);
            self.report_sms_result(&sms.id, false, Some(&error)).await?;
            return Err(anyhow!("Failed to send SMS: {}", error));
        }

        // Report success
        self.report_sms_result(&sms.id, true, None).await?;
        info!("✅ SMS sent successfully to {} (Message ID: {})", sms.recipient, sms.id);

        Ok(())
    }

    /// Report SMS result back to API
    pub async fn report_sms_result(&self, message_id: &str, success: bool, error_message: Option<&str>) -> Result<()> {
        let url = format!("{}/api/control/sms-result", self.api_client.config.api_url);

        let result = SmsResult {
            message_id: message_id.to_string(),
            success,
            error_message: error_message.map(|s| s.to_string()),
        };

        debug!("📤 Reporting SMS result for {}: success={}", message_id, success);

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
            return Err(anyhow!("Failed to report SMS result: {} - {}", status, text));
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

        info!("📤 Processing {} pending SMS messages", pending_messages.len());

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