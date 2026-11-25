use super::ModemManager;
use crate::at_modem::AtModemManager;
use crate::identifiers::SmsAddress;
use crate::types::SmsSubmission;
use anyhow::Result;
use tracing::{debug, info};

impl ModemManager {
    pub async fn delete_sms(&self, modem_id: &str, sms_path: &str) -> Result<()> {
        let locations = Self::parse_at_sms_path(sms_path)?;

        let port = self.get_port(modem_id).await;
        for (storage, index) in locations {
            if let Some(storage) = storage {
                self.at_modem
                    .delete_sms_from_storage(&port, storage, index)
                    .await?;
                debug!("Deleted SMS {}:{} via AT from {}", storage, index, modem_id);
            } else {
                // Rows created before storage-aware paths carry no storage.
                self.at_modem.delete_sms(&port, index).await?;
                debug!("Deleted legacy SMS {} via AT from {}", index, modem_id);
            }
        }
        Ok(())
    }

    pub async fn send_sms(
        &self,
        modem_id: &str,
        recipient: &SmsAddress,
        content: &str,
    ) -> Result<SmsSubmission> {
        self.send_sms_with_short_code(modem_id, recipient, content, false)
            .await
    }

    pub async fn send_sms_with_short_code(
        &self,
        modem_id: &str,
        recipient: &SmsAddress,
        content: &str,
        allow_short_code: bool,
    ) -> Result<SmsSubmission> {
        // These are interpolated into serial command strings, where a CR is an
        // injection (docs/SECURITY-REVIEW.md finding 3).
        AtModemManager::validate_recipient_with_short_code(recipient.as_str(), allow_short_code)?;
        AtModemManager::validate_message_body(content)?;

        let port = self.get_port(modem_id).await;
        let outcome = self
            .at_modem
            .send_sms_with_short_code(&port, recipient, content, allow_short_code)
            .await?;
        info!("Sent SMS via AT from modem {} to {}", modem_id, recipient);
        Ok(outcome)
    }
}
