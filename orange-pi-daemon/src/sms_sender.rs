use crate::identifiers::{Iccid, SmsAddress};
use crate::types::{PendingSms, PendingSmsResponse, SmsSubmission};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, error, info, warn};

// The transport includes failures, while successful modem submissions cannot.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum SmsReportOutcome {
    Confirmed,
    SubmittedUnconfirmed,
    Failed,
}

#[derive(Debug, Serialize)]
struct SmsResult<'a> {
    message_id: &'a str,
    outcome: SmsReportOutcome,
    error_message: Option<&'a str>,
}

impl<'a> SmsResult<'a> {
    fn new(message_id: &'a str, submission: Result<SmsSubmission, &'a str>) -> Self {
        let (outcome, error_message) = match submission {
            Ok(SmsSubmission::Confirmed) => (SmsReportOutcome::Confirmed, None),
            Ok(SmsSubmission::SubmittedUnconfirmed) => (
                SmsReportOutcome::SubmittedUnconfirmed,
                Some("SMS body submitted; modem did not return a final confirmation"),
            ),
            Err(error) => (SmsReportOutcome::Failed, Some(error)),
        };
        Self {
            message_id,
            outcome,
            error_message,
        }
    }
}

pub struct SmsSender {
    api_client: crate::api_client::ApiClient,
    modem_manager: Arc<crate::modem_manager::ModemManager>,
    modem_cache: HashMap<Iccid, String>, // ICCID -> modem_id mapping
    session_id: String,
}

impl SmsSender {
    pub fn new(
        api_client: crate::api_client::ApiClient,
        modem_manager: Arc<crate::modem_manager::ModemManager>,
        session_id: String,
    ) -> Self {
        Self {
            api_client,
            modem_manager,
            modem_cache: HashMap::new(),
            session_id,
        }
    }

    /// Update the modem cache with current ICCID mappings
    pub fn update_modem_cache(&mut self, cache: HashMap<Iccid, String>) {
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
            .header("X-Daemon-Session-Id", &self.session_id)
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow!("Failed to fetch pending SMS: {status} - {text}"));
        }

        let api_response: PendingSmsResponse = response.json().await?;

        if !api_response.pending_messages.is_empty() {
            info!(
                "📱 Found {} pending SMS messages to send",
                api_response.pending_messages.len()
            );
        }

        Ok(api_response.pending_messages)
    }

    /// Find modem ID for a given ICCID using cache or D-Bus
    pub async fn find_modem_for_iccid(&self, target_iccid: &Iccid) -> Option<String> {
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

                    if &iccid == target_iccid {
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

    /// Send an SMS message using `ModemManager` (AT commands or D-Bus)
    pub async fn send_sms(&self, sms: &PendingSms) -> Result<SmsSubmission> {
        // Find the modem for this ICCID
        let modem_id = match Iccid::try_from(sms.phone_iccid.as_str()) {
            Ok(iccid) => self.find_modem_for_iccid(&iccid).await,
            Err(_) => None,
        };
        let Some(modem_id) = modem_id else {
            error!("No modem found for ICCID: {}", sms.phone_iccid);
            let _ = self
                .report_sms_result(&sms.id, Err("No modem found for ICCID"))
                .await;
            return Err(anyhow!("ModemNotFound"));
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
                is_short_code(&sms.recipient),
            )
            .await
        {
            Ok(outcome) => {
                self.report_sms_result(&sms.id, Ok(outcome)).await?;
                match outcome {
                    SmsSubmission::Confirmed => info!(
                        "✅ SMS submission confirmed for {} (Message ID: {})",
                        sms.recipient, sms.id
                    ),
                    SmsSubmission::SubmittedUnconfirmed => warn!(
                        "⚠️ SMS submitted without final modem confirmation for {} (Message ID: {})",
                        sms.recipient, sms.id
                    ),
                }
                Ok(outcome)
            }
            Err(e) => {
                let error_msg = format!("Failed to send SMS: {e}");
                error!("{}", error_msg);
                self.report_sms_result(&sms.id, Err(&error_msg)).await?;
                Err(anyhow!(error_msg))
            }
        }
    }

    /// Report SMS result back to API
    pub async fn report_sms_result(
        &self,
        message_id: &str,
        submission: Result<SmsSubmission, &str>,
    ) -> Result<()> {
        let url = format!("{}/api/control/sms-result", self.api_client.config.api_url);

        let result = SmsResult::new(message_id, submission);

        debug!(
            "📤 Reporting SMS result for {}: outcome={:?}",
            message_id, result.outcome
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
            return Err(anyhow!("Failed to report SMS result: {status} - {text}"));
        }

        match result.outcome {
            SmsReportOutcome::Confirmed => debug!("✅ Marked SMS {} as sent", message_id),
            SmsReportOutcome::SubmittedUnconfirmed => {
                debug!(
                    "⚠️ Marked SMS {} as submitted without confirmation",
                    message_id
                );
            }
            SmsReportOutcome::Failed => debug!("⚠️ Marked SMS {} as failed", message_id),
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

fn is_short_code(recipient: &SmsAddress) -> bool {
    let recipient = recipient.as_str();
    (3..=5).contains(&recipient.len()) && recipient.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::{is_short_code, SmsResult};
    use crate::identifiers::SmsAddress;
    use crate::types::SmsSubmission;
    use serde_json::json;

    #[test]
    fn serializes_confirmed_submission_without_an_error() {
        let result = SmsResult::new("message-1", Ok(SmsSubmission::Confirmed));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"message_id": "message-1", "outcome": "confirmed", "error_message": null})
        );
    }

    #[test]
    fn serializes_unconfirmed_submission_with_its_delivery_warning() {
        let result = SmsResult::new("message-1", Ok(SmsSubmission::SubmittedUnconfirmed));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "message_id": "message-1",
                "outcome": "submitted_unconfirmed",
                "error_message": "SMS body submitted; modem did not return a final confirmation"
            })
        );
    }

    #[test]
    fn serializes_failed_submission_with_its_error() {
        let result = SmsResult::new("message-1", Err("Modem not found"));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "message_id": "message-1",
                "outcome": "failed",
                "error_message": "Modem not found"
            })
        );
    }

    #[test]
    fn recognizes_only_plain_ascii_short_codes() {
        assert!(is_short_code(&SmsAddress::from("100")));
        assert!(is_short_code(&SmsAddress::from("10010")));
        assert!(!is_short_code(&SmsAddress::from("12")));
        assert!(!is_short_code(&SmsAddress::from("+10010")));
        assert!(!is_short_code(&SmsAddress::from("1001A")));
        assert!(!is_short_code(&SmsAddress::from("6512345678")));
    }
}
