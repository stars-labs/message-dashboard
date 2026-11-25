use super::{AtModemManager, AtSms};
use crate::types::SmsStorage;
use anyhow::{anyhow, Result};
use std::time::Duration;
use tracing::{debug, warn};

impl AtModemManager {
    /// Scans each read storage independently: the EC20 treats `MT` as an alias for `ME`,
    /// not as `ME` + `SM`.
    pub async fn list_sms(&self, port: &str) -> Result<Vec<AtSms>> {
        let stores = self.sms_read_stores(port).await;
        let mut messages = Vec::new();
        let mut successful_stores = 0;
        let mut failures = Vec::new();

        for storage in stores {
            if let Err(e) = self.select_sms_storage(port, storage).await {
                warn!(
                    "Failed to select SMS storage {} on {}: {}; trying next storage",
                    storage, port, e
                );
                failures.push(format!("{storage} selection: {e}"));
                continue;
            }

            match self.list_sms_from_selected_storage(port).await {
                Ok(mut stored_messages) => {
                    for message in &mut stored_messages {
                        message.storage = Some(storage);
                    }
                    debug!(
                        "SMS storage {}: got {} messages from {}",
                        storage,
                        stored_messages.len(),
                        port
                    );
                    messages.append(&mut stored_messages);
                    successful_stores += 1;
                }
                Err(e) => {
                    warn!(
                        "Failed to scan SMS storage {} on {}: {}; trying next storage",
                        storage, port, e
                    );
                    failures.push(format!("{storage} scan: {e}"));
                }
            }
        }

        if successful_stores == 0 {
            return Err(anyhow!(
                "Failed to scan every SMS storage on {}: {}",
                port,
                failures.join("; ")
            ));
        }

        Ok(messages)
    }

    async fn list_sms_from_selected_storage(&self, port: &str) -> Result<Vec<AtSms>> {
        match self.list_sms_pdu_mode(port).await {
            Ok(messages) if !messages.is_empty() => {
                debug!("PDU mode: got {} messages from {}", messages.len(), port);
                Ok(messages)
            }
            Ok(_) => {
                debug!("PDU mode returned empty, trying text mode on {}", port);
                let messages = self.list_sms_text_mode(port).await?;
                debug!("Text mode: got {} messages from {}", messages.len(), port);
                Ok(messages)
            }
            Err(e) => {
                warn!(
                    "PDU mode failed on {}: {} - falling back to text mode",
                    port, e
                );
                let messages = self.list_sms_text_mode(port).await?;
                debug!(
                    "Text mode fallback: got {} messages from {}",
                    messages.len(),
                    port
                );
                Ok(messages)
            }
        }
    }

    /// EC20 is scanned as ME then SM; MT only when neither is advertised.
    async fn sms_read_stores(&self, port: &str) -> Vec<SmsStorage> {
        match self.send_at_command(port, "AT+CPMS=?", self.timeout).await {
            Ok(response) => {
                let supported = Self::parse_cpms_read_stores(&response);
                let stores = Self::sms_read_store_candidates(&supported);
                if stores.is_empty() {
                    warn!(
                        "Modem {} advertised no usable SMS read storage; trying ME and SM",
                        port
                    );
                    vec![SmsStorage::Me, SmsStorage::Sm]
                } else {
                    stores
                }
            }
            Err(e) => {
                warn!(
                    "Failed to query SMS storage capabilities on {}: {}; trying ME and SM",
                    port, e
                );
                vec![SmsStorage::Me, SmsStorage::Sm]
            }
        }
    }

    async fn select_sms_storage(&self, port: &str, storage: SmsStorage) -> Result<()> {
        let command = Self::select_sms_storage_command(storage);
        self.send_at_command(port, &command, self.timeout).await?;
        Ok(())
    }

    pub(super) fn select_sms_storage_command(storage: SmsStorage) -> String {
        format!("AT+CPMS=\"{storage}\"")
    }

    /// Parse mem1 capabilities from `+CPMS: ("ME","MT",...),(...),(...)`.
    pub(super) fn parse_cpms_read_stores(response: &str) -> Vec<String> {
        let Some(line) = response.lines().find(|line| line.contains("+CPMS:")) else {
            return Vec::new();
        };
        let Some((inside, _)) = line
            .split_once('(')
            .and_then(|(_, after)| after.split_once(')'))
        else {
            return Vec::new();
        };

        Self::parse_quoted_values(inside)
    }

    fn parse_quoted_values(value: &str) -> Vec<String> {
        value
            .split('"')
            .enumerate()
            .filter(|(index, _)| index % 2 == 1)
            .map(|(_, value)| value.trim().to_ascii_uppercase())
            .filter(|value| !value.is_empty())
            .collect()
    }

    pub(super) fn sms_read_store_candidates(supported: &[String]) -> Vec<SmsStorage> {
        let mut stores: Vec<SmsStorage> = [SmsStorage::Me, SmsStorage::Sm]
            .into_iter()
            .filter(|candidate| supported.iter().any(|store| store == candidate.as_str()))
            .collect();

        if stores.is_empty()
            && supported
                .iter()
                .any(|store| store == SmsStorage::Mt.as_str())
        {
            stores.push(SmsStorage::Mt);
        }
        stores
    }

    async fn list_sms_text_mode(&self, port: &str) -> Result<Vec<AtSms>> {
        self.send_at_command(port, "AT+CMGF=1", self.timeout)
            .await?;

        // UCS2 is needed for Chinese text; on failure the modem keeps its default charset.
        match self
            .send_at_command(port, "AT+CSCS=\"UCS2\"", self.timeout)
            .await
        {
            Ok(_) => {
                debug!("Text mode: UCS2 charset set successfully on {}", port);
            }
            Err(e) => {
                warn!(
                    "Text mode: Failed to set UCS2 charset on {}: {} - using default",
                    port, e
                );
            }
        }

        let response = self
            .send_at_command(port, "AT+CMGL=\"ALL\"", Duration::from_secs(10))
            .await?;

        let mut messages = Vec::new();
        let mut lines = response.lines().map(str::trim);

        while let Some(line) = lines.next() {
            // +CMGL: 1,"REC READ","+1234567890","","24/01/15,10:30:45+32"
            if line.contains("+CMGL:") {
                if let Some(sms) = Self::parse_cmgl_header(line) {
                    if let Some(raw_text) = lines.next() {
                        if !raw_text.is_empty() && raw_text != "OK" && !raw_text.contains("+CMGL:")
                        {
                            let text = Self::decode_sms_content(raw_text);
                            messages.push(AtSms {
                                storage: None,
                                index: sms.0,
                                sender: sms.1,
                                timestamp: sms.2,
                                text,
                                concat_info: None,
                            });
                        }
                    }
                }
            }
        }

        Ok(messages)
    }

    /// PDU mode, unlike text mode, exposes the UDH concatenation info.
    async fn list_sms_pdu_mode(&self, port: &str) -> Result<Vec<AtSms>> {
        self.send_at_command(port, "AT+CMGF=0", self.timeout)
            .await?;

        let response = self
            .send_at_command(port, "AT+CMGL=4", Duration::from_secs(10))
            .await?;

        let mut messages = Vec::new();
        let mut lines = response.lines().map(str::trim);

        while let Some(line) = lines.next() {
            // +CMGL: <index>,<stat>,<alpha>,<length>, e.g. 0,1,,23
            if line.contains("+CMGL:") {
                if let Some(index) = Self::parse_cmgl_pdu_header(line) {
                    if let Some(pdu_hex) = lines.next() {
                        if !pdu_hex.is_empty() && pdu_hex != "OK" && !pdu_hex.contains("+CMGL:") {
                            if let Ok(sms) = Self::parse_pdu_sms(index, pdu_hex) {
                                messages.push(sms);
                            }
                        }
                    }
                }
            }
        }

        Ok(messages)
    }

    fn parse_cmgl_pdu_header(line: &str) -> Option<u32> {
        let first_field = line.split(',').next()?;

        let index_part = first_field.split(':').next_back()?.trim();
        index_part.parse::<u32>().ok()
    }

    pub async fn delete_sms(&self, port: &str, index: u32) -> Result<()> {
        let cmd = format!("AT+CMGD={index}");
        let response = self.send_at_command(port, &cmd, self.timeout).await?;

        if response.contains("OK") {
            debug!("Deleted SMS {} from {}", index, port);
            Ok(())
        } else {
            Err(anyhow!("Failed to delete SMS {index}: {response}"))
        }
    }

    /// Indices are scoped to CPMS mem1, so the storage must be selected first.
    pub async fn delete_sms_from_storage(
        &self,
        port: &str,
        storage: SmsStorage,
        index: u32,
    ) -> Result<()> {
        self.select_sms_storage(port, storage).await?;
        self.delete_sms(port, index).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cmgl_pdu_header_reads_the_index_before_the_first_comma() {
        assert_eq!(
            AtModemManager::parse_cmgl_pdu_header("+CMGL: 0,1,,23"),
            Some(0)
        );
        assert_eq!(
            AtModemManager::parse_cmgl_pdu_header("+CMGL: 12,0,,159"),
            Some(12)
        );
        assert_eq!(AtModemManager::parse_cmgl_pdu_header("+CMGL:7"), Some(7));
        assert_eq!(
            AtModemManager::parse_cmgl_pdu_header("  +CMGL:  3 "),
            Some(3)
        );
    }

    #[test]
    fn parse_cmgl_pdu_header_refuses_a_non_numeric_or_missing_index() {
        for line in ["+CMGL: abc,1,,23", "+CMGL:", "+CMGL: -1,1", "+CMGL: ,1", ""] {
            assert_eq!(
                AtModemManager::parse_cmgl_pdu_header(line),
                None,
                "{line:?}"
            );
        }
    }
}
