use super::{read_chunk, AtModemManager};
use crate::identifiers::SmsAddress;
use crate::types::SmsSubmission;
use anyhow::{anyhow, Result};
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use tracing::warn;

pub(super) const SMS_PROMPT_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const SMS_PROMPT_TIMEOUT_ERROR: &str = "Timeout waiting for > prompt";
const SMS_PROMPT_RETRY_DELAY: Duration = Duration::from_secs(1);

impl AtModemManager {
    fn encode_ucs2_hex(text: &str) -> String {
        use std::fmt::Write as _;
        text.encode_utf16().fold(String::new(), |mut hex, unit| {
            let _ = write!(hex, "{unit:04X}");
            hex
        })
    }

    fn needs_ucs2(text: &str) -> bool {
        !text.is_ascii()
    }

    /// AT commands are CR-terminated, so a CR in the recipient ends `AT+CMGS="..."` and
    /// the modem parses the remaining bytes as a new command; the recipient comes from
    /// an API request body (docs/SECURITY-REVIEW.md finding 3).
    ///
    /// Allow-lists E.164 and rejects rather than strips: stripping would send the
    /// message to a different number than the caller asked for.
    pub(crate) fn validate_recipient_with_short_code(
        recipient: &str,
        allow_short_code: bool,
    ) -> Result<()> {
        if allow_short_code
            && (3..=5).contains(&recipient.len())
            && recipient.bytes().all(|b| b.is_ascii_digit())
        {
            return Ok(());
        }

        let digits = recipient.strip_prefix('+').unwrap_or(recipient);

        if digits.len() < 6 || digits.len() > 15 {
            return Err(anyhow!(
                "Invalid SMS recipient: expected 6-15 digits, got {} character(s)",
                digits.len()
            ));
        }

        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            // Do not echo the raw value; it may contain control characters.
            return Err(anyhow!(
                "Invalid SMS recipient: must be E.164 (optional leading '+' then digits only)"
            ));
        }

        Ok(())
    }

    /// The body is terminated by Ctrl-Z (0x1A), so a literal 0x1A ends SMS entry early
    /// and turns every trailing byte into an AT command. ESC (0x1B) aborts entry; NUL
    /// is never legitimate. Newlines are allowed.
    pub(crate) fn validate_message_body(message: &str) -> Result<()> {
        if let Some(c) = message
            .chars()
            .find(|&c| c == '\x1A' || c == '\x1B' || c == '\0')
        {
            return Err(anyhow!(
                "Invalid SMS body: contains control character U+{:04X}",
                u32::from(c)
            ));
        }

        Ok(())
    }

    pub async fn send_sms_with_short_code(
        &self,
        port: &str,
        recipient: &SmsAddress,
        message: &str,
        allow_short_code: bool,
    ) -> Result<SmsSubmission> {
        // Both values are interpolated into AT commands and come from an API request body.
        Self::validate_recipient_with_short_code(recipient.as_str(), allow_short_code)?;
        Self::validate_message_body(message)?;

        let use_ucs2 = Self::needs_ucs2(message);
        let port_lock = self.port_lock(port).await;
        let _guard = port_lock.lock().await;

        match self
            .submit_sms_unlocked(port, recipient, message, use_ucs2, allow_short_code)
            .await
        {
            Err(error) if Self::is_prompt_timeout(&error) => {
                warn!(
                    "SMS prompt timed out on {}; recovering and retrying once",
                    port
                );
                tokio::time::sleep(SMS_PROMPT_RETRY_DELAY).await;
                self.submit_sms_unlocked(port, recipient, message, use_ucs2, allow_short_code)
                    .await
            }
            result => result,
        }
    }

    /// The caller holds the port lock.
    async fn submit_sms_unlocked(
        &self,
        port: &str,
        recipient: &SmsAddress,
        message: &str,
        use_ucs2: bool,
        allow_short_code: bool,
    ) -> Result<SmsSubmission> {
        let recovery_response = self.recover_sms_input_unlocked(port).await?;
        Self::require_recovered_at_channel(&recovery_response)?;
        self.configure_sms_unlocked(port, use_ucs2).await?;

        let port_path = port.to_string();
        let recipient = recipient.as_str().to_owned();
        let msg = message.to_string();
        let timeout = self.timeout;
        let result = tokio::task::spawn_blocking(move || {
            Self::send_sms_sync(
                &port_path,
                &recipient,
                &msg,
                timeout,
                use_ucs2,
                allow_short_code,
            )
        })
        .await?;

        let outcome = result?;
        if Self::should_recover_after_submit(outcome) {
            warn!(
                "SMS submission was not confirmed on {}; recovering AT channel",
                port
            );
            match self.recover_sms_input_unlocked(port).await {
                Ok(response) => {
                    Self::classify_post_submit_recovery_response(&response)?;
                    if let Err(error) = Self::require_recovered_at_channel(&response) {
                        warn!(
                            "Failed to recover AT channel after unconfirmed SMS submission on {}: {}",
                            port, error
                        );
                    }
                }
                Err(error) => warn!(
                    "Failed to recover AT channel after unconfirmed SMS submission on {}: {}",
                    port, error
                ),
            }
        }
        Ok(outcome)
    }

    async fn configure_sms_unlocked(&self, port: &str, use_ucs2: bool) -> Result<()> {
        Self::send_at_command_unlocked(port, "AT+CMGF=1", self.timeout).await?;

        if use_ucs2 {
            Self::send_at_command_unlocked(port, "AT+CSCS=\"UCS2\"", self.timeout).await?;
            // AT+CSMP=<fo>,<vp>,<pid>,<dcs>; fo=49 (0x31) is SMS-SUBMIT with a status report
            // requested and a relative validity period (vp=0 is 5 minutes); dcs 8 = UCS2.
            Self::send_at_command_unlocked(port, "AT+CSMP=49,0,0,8", self.timeout).await?;
        } else {
            Self::send_at_command_unlocked(port, "AT+CSCS=\"GSM\"", self.timeout).await?;
            Self::send_at_command_unlocked(port, "AT+CSMP=49,0,0,0", self.timeout).await?;
        }

        Ok(())
    }

    pub(super) fn is_prompt_timeout(error: &anyhow::Error) -> bool {
        error.to_string() == SMS_PROMPT_TIMEOUT_ERROR
    }

    pub(super) fn should_recover_after_submit(outcome: SmsSubmission) -> bool {
        matches!(outcome, SmsSubmission::SubmittedUnconfirmed)
    }

    pub(super) fn classify_post_submit_recovery_response(response: &str) -> Result<()> {
        if let Some(error) = Self::sms_submit_error_line(response) {
            return Err(anyhow!("Send SMS failed after submission: {error}"));
        }
        Ok(())
    }

    fn send_sms_sync(
        port: &str,
        recipient: &str,
        message: &str,
        timeout: Duration,
        use_ucs2: bool,
        allow_short_code: bool,
    ) -> Result<SmsSubmission> {
        // Re-checked here because this is the function that writes to the serial port.
        Self::validate_recipient_with_short_code(recipient, allow_short_code)?;
        Self::validate_message_body(message)?;

        let mut file = Self::open_serial(port)?;

        // In UCS2 mode both the recipient and the message are UCS2 hex.
        let (encoded_recipient, encoded_message) = if use_ucs2 {
            (
                Self::encode_ucs2_hex(recipient),
                Self::encode_ucs2_hex(message),
            )
        } else {
            (recipient.to_string(), message.to_string())
        };

        let cmd = format!("AT+CMGS=\"{encoded_recipient}\"\r");
        file.write_all(cmd.as_bytes())?;
        file.flush()?;

        let mut prompt_buf = Vec::new();
        let mut buf = [0u8; 64];
        let start = Instant::now();
        let mut got_prompt = false;

        while start.elapsed() < SMS_PROMPT_TIMEOUT {
            match file.read(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(n) => {
                    prompt_buf.extend_from_slice(read_chunk(&buf, n)?);
                    let text = String::from_utf8_lossy(&prompt_buf);
                    if text.contains('>') {
                        got_prompt = true;
                        break;
                    }
                    if text.contains("ERROR") {
                        return Err(anyhow!("CMGS command failed: {text}"));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(anyhow!("Read error waiting for prompt: {e}")),
            }
        }

        if !got_prompt {
            return Err(anyhow!(SMS_PROMPT_TIMEOUT_ERROR));
        }

        std::thread::sleep(Duration::from_millis(100));

        // Ctrl-Z (0x1A) terminates the body
        let msg_with_end = format!("{encoded_message}\x1A");
        file.write_all(msg_with_end.as_bytes())?;
        file.flush()?;

        let mut response = Vec::new();
        let mut buf = [0u8; 256];
        let start = Instant::now();

        let timed_out = loop {
            if start.elapsed() > timeout {
                break true;
            }

            match file.read(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(n) => {
                    response.extend_from_slice(read_chunk(&buf, n)?);
                    let text = String::from_utf8_lossy(&response);
                    if Self::has_sms_submit_final_code(&text) {
                        break false;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(anyhow!("Read error: {e}")),
            }
        };

        let response_str = String::from_utf8_lossy(&response);
        Self::classify_sms_submit_response(&response_str, timed_out)
    }

    pub(super) fn classify_sms_submit_response(
        response: &str,
        timed_out: bool,
    ) -> Result<SmsSubmission> {
        let lines = response
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty());
        if Self::sms_submit_error_line(response).is_some() {
            return Err(anyhow!("Send SMS failed: {response}"));
        }
        if lines
            .clone()
            .any(|line| line == "OK" || line.starts_with("+CMGS:"))
        {
            return Ok(SmsSubmission::Confirmed);
        }
        if timed_out {
            return Ok(SmsSubmission::SubmittedUnconfirmed);
        }
        Err(anyhow!("Send SMS failed: {response}"))
    }

    pub(super) fn has_sms_submit_final_code(response: &str) -> bool {
        Self::sms_submit_error_line(response).is_some()
            || response
                .lines()
                .map(str::trim)
                .any(|line| line == "OK" || line.starts_with("+CMGS:"))
    }

    fn sms_submit_error_line(response: &str) -> Option<&str> {
        response.lines().map(str::trim).find(|line| {
            *line == "ERROR" || line.starts_with("+CMS ERROR:") || line.starts_with("+CME ERROR:")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_ucs2_hex_writes_four_uppercase_hex_digits_per_utf16_unit() {
        assert_eq!(AtModemManager::encode_ucs2_hex(""), "");
        assert_eq!(AtModemManager::encode_ucs2_hex("A"), "0041");
        assert_eq!(AtModemManager::encode_ucs2_hex("+65"), "002B00360035");
        assert_eq!(AtModemManager::encode_ucs2_hex("你好"), "4F60597D");
    }

    #[test]
    fn encode_ucs2_hex_splits_a_character_outside_the_bmp_into_a_surrogate_pair() {
        assert_eq!(AtModemManager::encode_ucs2_hex("\u{1F600}"), "D83DDE00");
    }

    #[test]
    fn only_non_ascii_text_needs_ucs2() {
        assert!(!AtModemManager::needs_ucs2(""));
        assert!(!AtModemManager::needs_ucs2("Code 1234, reply STOP\r\n"));
        assert!(AtModemManager::needs_ucs2("caf\u{e9}"));
        assert!(AtModemManager::needs_ucs2("验证码"));
    }

    #[test]
    fn sms_submit_error_line_returns_the_trimmed_error_line() {
        assert_eq!(
            AtModemManager::sms_submit_error_line("> \r\n  +CMS ERROR: 500  \r\n"),
            Some("+CMS ERROR: 500")
        );
        assert_eq!(
            AtModemManager::sms_submit_error_line("+CME ERROR: SIM busy"),
            Some("+CME ERROR: SIM busy")
        );
        assert_eq!(
            AtModemManager::sms_submit_error_line("+CMGS: 1\r\nOK"),
            None
        );
        assert_eq!(AtModemManager::sms_submit_error_line("ERROR 5"), None);
    }
}
