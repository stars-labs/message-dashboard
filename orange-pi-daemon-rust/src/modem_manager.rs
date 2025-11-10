use anyhow::{Context, Result};
use crate::types::*;
use crate::dbus_client::DBusClient;
use crate::signal_cache::SignalCache;
use chrono::TimeZone;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use tracing::{debug, info};

#[derive(Clone)]
pub struct ModemManager {
    dbus_client: Arc<DBusClient>,
    signal_cache: Arc<SignalCache>,
}

impl ModemManager {
    pub fn new() -> Self {
        Self {
            dbus_client: Arc::new(DBusClient::new()),
            signal_cache: Arc::new(SignalCache::new(30)), // 30 second cache TTL
        }
    }

    /// Execute mmcli command with timeout to prevent hanging
    async fn execute_mmcli_with_timeout(&self, args: &[&str]) -> Result<std::process::Output> {
        const MMCLI_TIMEOUT: Duration = Duration::from_secs(10); // 10 second timeout for mmcli commands

        let mut cmd = tokio::process::Command::new("mmcli");
        for arg in args {
            cmd.arg(arg);
        }

        match timeout(MMCLI_TIMEOUT, cmd.output()).await {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(e)) => Err(anyhow::anyhow!("Failed to execute mmcli: {}", e)),
            Err(_) => Err(anyhow::anyhow!("mmcli command timed out after {:?}", MMCLI_TIMEOUT)),
        }
    }
    
    /// List all modem IDs (D-Bus first, fallback to mmcli)
    pub async fn list_modems(&self) -> Result<Vec<String>> {
        // Try D-Bus first (90% faster)
        match self.dbus_client.list_modems().await {
            Ok(modems) => {
                debug!("🚀 Listed {} modems via D-Bus", modems.len());
                Ok(modems)
            }
            Err(_) => {
                debug!("⚠️  D-Bus failed, falling back to mmcli");
                self.list_modems_mmcli().await
            }
        }
    }

    /// Get ICCID for a modem (D-Bus first, fallback to mmcli)
    pub async fn get_iccid(&self, modem_id: &str) -> Result<Option<String>> {
        // Try D-Bus first
        match self.dbus_client.get_sim_iccid(modem_id).await {
            Ok(iccid) => Ok(iccid),
            Err(_) => {
                debug!("⚠️  D-Bus failed for modem {}, falling back to mmcli", modem_id);
                self.get_iccid_mmcli(modem_id).await
            }
        }
    }

    /// Get signal quality (cached, D-Bus first, fallback to mmcli)
    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        // Check cache first
        if let Some(cached_signal) = self.signal_cache.get(modem_id).await {
            return Ok(cached_signal);
        }

        // Not in cache, fetch fresh data
        let signal = match self.dbus_client.get_signal_quality(modem_id).await {
            Ok((percent, _recent)) => {
                SignalData {
                    percent: percent as i32,
                    rssi: (percent as i32 * 120 / 100) - 110,
                }
            }
            Err(_) => {
                debug!("⚠️  D-Bus failed for signal {}, falling back to mmcli", modem_id);
                self.get_signal_quality_mmcli(modem_id).await?
            }
        };

        // Cache the result
        self.signal_cache.set(modem_id.to_string(), signal.clone()).await;

        Ok(signal)
    }

    /// Get device details (D-Bus first, fallback to mmcli)
    pub async fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
        // Try D-Bus first
        match self.dbus_client.get_device_details(modem_id).await {
            Ok(details) => {
                let imei = if details.imei.is_empty() {
                    format!("MODEM_{}", modem_id)
                } else {
                    details.imei
                };
                Ok((imei, details.manufacturer, details.model, details.firmware_revision, details.hardware_revision))
            }
            Err(_) => {
                debug!("⚠️  D-Bus failed for device details {}, falling back to mmcli", modem_id);
                self.get_device_details_mmcli(modem_id).await
            }
        }
    }

    /// Get phone number (D-Bus first, fallback to mmcli)
    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<String>> {
        // Try D-Bus first
        match self.dbus_client.get_phone_number(modem_id).await {
            Ok(number) => Ok(number),
            Err(_) => {
                debug!("⚠️  D-Bus failed for phone number {}, falling back to mmcli", modem_id);
                self.get_phone_number_mmcli(modem_id).await
            }
        }
    }

    /// Get operator name (D-Bus first, fallback to mmcli)
    pub async fn get_operator(&self, modem_id: &str) -> Result<Option<String>> {
        // Try D-Bus first
        match self.dbus_client.get_operator(modem_id).await {
            Ok(operator) => Ok(operator),
            Err(_) => {
                debug!("⚠️  D-Bus failed for operator {}, falling back to mmcli", modem_id);
                self.get_operator_mmcli(modem_id).await
            }
        }
    }
    
    // MMCLI implementations
    async fn list_modems_mmcli(&self) -> Result<Vec<String>> {
        let output = self.execute_mmcli_with_timeout(&["-L"])
            .await
            .context("Failed to list modems")?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut modems = Vec::new();
        
        // Parse: /org/freedesktop/ModemManager1/Modem/123
        for line in stdout.lines() {
            if let Some(modem_id) = Self::extract_modem_id(line) {
                modems.push(modem_id);
            }
        }
        
        Ok(modems)
    }
    
    /// Get ICCID for a modem
    async fn get_iccid_mmcli(&self, modem_id: &str) -> Result<Option<String>> {
        // First get SIM path
        let output = self.execute_mmcli_with_timeout(&["-m", modem_id])
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Extract SIM path: sim: /org/freedesktop/ModemManager1/SIM/123
        let sim_id = stdout
            .lines()
            .find(|l| l.trim().starts_with("sim:") || l.contains("/SIM/"))
            .and_then(|l| l.split("/SIM/").nth(1))
            .and_then(|s| s.split_whitespace().next());
        
        let sim_id = match sim_id {
            Some(id) => id,
            None => return Ok(None),
        };
        
        // Query SIM for ICCID
        let sim_output = self.execute_mmcli_with_timeout(&["-i", sim_id])
            .await?;
        
        let sim_stdout = String::from_utf8_lossy(&sim_output.stdout);
        
        // Extract ICCID: iccid: 1234567890
        let iccid = sim_stdout
            .lines()
            .find(|l| l.contains("iccid:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string());
        
        Ok(iccid)
    }
    
    /// Get phone number
    async fn get_phone_number_mmcli(&self, modem_id: &str) -> Result<Option<String>> {
        let output = self.execute_mmcli_with_timeout(&["-m", modem_id])
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Extract: own: +1234567890
        let number = stdout
            .lines()
            .find(|l| l.contains("own:") || l.contains("number:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "unknown");
        
        Ok(number)
    }
    
    /// Get signal quality
    async fn get_signal_quality_mmcli(&self, modem_id: &str) -> Result<SignalData> {
        let output = self.execute_mmcli_with_timeout(&["-m", modem_id])
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Parse: signal quality: 75% (recent)
        let percent = stdout
            .lines()
            .find(|l| l.contains("signal quality:"))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|s| s.trim().split('%').next())
            .and_then(|s| s.trim().parse::<i32>().ok())
            .unwrap_or(0);
        
        Ok(SignalData {
            percent,
            rssi: (percent * 120 / 100) - 110, // Approximate RSSI from percentage
        })
    }
    
    /// Get new SMS messages
    pub async fn get_new_messages(&self, modem_id: &str, iccid: &str) -> Result<Vec<Message>> {
        // List SMS
        let output = self.execute_mmcli_with_timeout(&["-m", modem_id, "--messaging-list-sms"])
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut messages = Vec::new();
        
        // Extract SMS IDs
        for line in stdout.lines() {
            if let Some(sms_id) = Self::extract_sms_id(line) {
                if let Ok(Some(msg)) = self.read_sms(modem_id, &sms_id, iccid).await {
                    messages.push(msg);
                    // Delete after reading to prevent reprocessing
                    let _ = self.delete_sms(modem_id, &sms_id).await;
                }
            }
        }
        
        Ok(messages)
    }
    
    /// Read a specific SMS
    async fn read_sms(&self, modem_id: &str, sms_id: &str, iccid: &str) -> Result<Option<Message>> {
        let output = self.execute_mmcli_with_timeout(&["-m", modem_id, "--sms", sms_id])
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Parse SMS fields
        let mut content = String::new();
        let mut number = String::new();
        let mut timestamp = String::new();
        
        for line in stdout.lines() {
            let line = line.trim();
            if line.contains("text:") {
                content = line.split(':').skip(1).collect::<Vec<_>>().join(":").trim().to_string();
            } else if line.contains("number:") {
                number = line.split(':').nth(1).unwrap_or("").trim().to_string();
            } else if line.contains("timestamp:") {
                // Parse timestamp properly - mmcli can output various formats
                // Examples: "timestamp: 2025-10-05T14:23:45+08:00" or "timestamp: 10/5/2025, 2:23:45 PM"
                if let Some(colon_pos) = line.find(':') {
                    // Get everything after the first colon and trim whitespace
                    let raw_timestamp = line[colon_pos + 1..].trim();
                    tracing::debug!("📅 Raw timestamp from mmcli: '{}'", raw_timestamp);
                    
                    // Clean up potential quotes and extra whitespace
                    let cleaned = raw_timestamp.trim_matches(|c| c == '"' || c == '\'' || c == ' ');
                    timestamp = self.normalize_timestamp(cleaned).unwrap_or_else(|e| {
                        tracing::warn!("⚠️  Failed to parse timestamp '{}': {}, using current time", cleaned, e);
                        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
                    });
                    
                    tracing::debug!("📅 Normalized timestamp: '{}'", timestamp);
                }
            }
        }
        
        if content.is_empty() {
            return Ok(None);
        }
        
        // Use current time if no timestamp was found
        if timestamp.is_empty() {
            timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
            tracing::debug!("📅 No timestamp found, using current time: {}", timestamp);
        }
        
        Ok(Some(Message {
            phone_iccid: iccid.to_string(),
            phone_number: number,
            content,
            timestamp,
            direction: "received".to_string(),
        }))
    }
    
    /// Delete SMS after processing
    pub async fn delete_sms(&self, modem_id: &str, sms_id: &str) -> Result<()> {
        self.execute_mmcli_with_timeout(&["-m", modem_id, "--messaging-delete-sms", sms_id])
            .await?;
        
        Ok(())
    }
    
    /// Get device details (IMEI, manufacturer, model, etc.)
    async fn get_device_details_mmcli(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
        let output = self.execute_mmcli_with_timeout(&["-m", modem_id])
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let mut imei = String::new();
        let mut manufacturer = None;
        let mut model = None;
        let mut firmware = None;
        let hardware = None;
        
        for line in stdout.lines() {
            let line = line.trim();
            if line.contains("equipment id:") {
                imei = line.split(':').nth(1).unwrap_or("").trim().to_string();
            } else if line.contains("manufacturer:") {
                manufacturer = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            } else if line.contains("model:") {
                model = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            } else if line.contains("firmware") || line.contains("revision:") {
                firmware = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            }
        }
        
        // Generate synthetic IMEI if missing
        if imei.is_empty() {
            imei = format!("MODEM_{}", modem_id);
        }
        
        Ok((imei, manufacturer, model, firmware, hardware))
    }
    
    /// Get operator name
    async fn get_operator_mmcli(&self, modem_id: &str) -> Result<Option<String>> {
        let output = self.execute_mmcli_with_timeout(&["-m", modem_id])
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let operator = stdout
            .lines()
            .find(|l| l.contains("operator name:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        
        Ok(operator)
    }
    
    
    /// Normalize timestamp to RFC3339 UTC format
    fn normalize_timestamp(&self, raw_timestamp: &str) -> Result<String> {
        tracing::debug!("📅 Normalizing timestamp: '{}'", raw_timestamp);
        
        // First try: Parse as RFC3339 (ISO format with timezone)
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw_timestamp) {
            let utc_timestamp = dt.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
            tracing::debug!("📅 Parsed as RFC3339, converted to UTC: {}", utc_timestamp);
            return Ok(utc_timestamp);
        }
        
        // Second try: Parse as naive datetime and assume UTC
        if let Ok(naive_dt) = chrono::NaiveDateTime::parse_from_str(raw_timestamp, "%Y-%m-%dT%H:%M:%S") {
            let utc_timestamp = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive_dt, chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
            tracing::debug!("📅 Parsed as naive datetime, assumed UTC: {}", utc_timestamp);
            return Ok(utc_timestamp);
        }
        
        // Third try: Parse US date format like "10/5/2025, 2:23:45 PM"
        if raw_timestamp.contains('/') && raw_timestamp.contains(',') {
            if let Some(formatted) = self.parse_us_date_format(raw_timestamp) {
                tracing::debug!("📅 Parsed US date format: {} -> {}", raw_timestamp, formatted);
                return Ok(formatted);
            }
        }
        
        // Fourth try: Handle timezone offset formats like "2025-10-05T14:23:45+08:00" or "2025-10-05T14:23:45+0800"
        if let Some(formatted) = self.parse_timezone_offset_format(raw_timestamp) {
            tracing::debug!("📅 Parsed timezone offset format: {} -> {}", raw_timestamp, formatted);
            return Ok(formatted);
        }
        
        Err(anyhow::anyhow!("Unable to parse timestamp format: {}", raw_timestamp))
    }
    
    /// Parse US date format like "10/5/2025, 2:23:45 PM"
    fn parse_us_date_format(&self, timestamp: &str) -> Option<String> {
        // Split by comma to separate date and time
        let parts: Vec<&str> = timestamp.split(',').collect();
        if parts.len() != 2 {
            return None;
        }
        
        let date_part = parts[0].trim();
        let time_part = parts[1].trim();
        
        // Parse date part (M/D/YYYY or MM/DD/YYYY)
        let date_components: Vec<&str> = date_part.split('/').collect();
        if date_components.len() != 3 {
            return None;
        }
        
        let month: u32 = date_components[0].parse().ok()?;
        let day: u32 = date_components[1].parse().ok()?;
        let year: u32 = date_components[2].parse().ok()?;
        
        // Parse time part (H:MM:SS AM/PM)
        let is_pm = time_part.to_uppercase().contains("PM");
        let time_clean = time_part.replace("AM", "").replace("PM", "");
        let time_clean = time_clean.trim();
        let time_components: Vec<&str> = time_clean.split(':').collect();
        if time_components.len() < 2 {
            return None;
        }
        
        let mut hour: u32 = time_components[0].parse().ok()?;
        let minute: u32 = time_components[1].parse().ok()?;
        let second: u32 = if time_components.len() > 2 {
            time_components[2].parse().unwrap_or(0)
        } else {
            0
        };
        
        // Convert 12-hour to 24-hour format
        if is_pm && hour != 12 {
            hour += 12;
        } else if !is_pm && hour == 12 {
            hour = 0;
        }
        
        // Create datetime (assume UTC+8 Beijing time, then convert to UTC)
        if let Some(naive_dt) = chrono::NaiveDate::from_ymd_opt(year as i32, month, day)
            .and_then(|date| date.and_hms_opt(hour, minute, second)) {

            // Assume Beijing time (UTC+8) and convert to UTC
            let beijing_tz = chrono::FixedOffset::east_opt(8 * 3600)?;
            let beijing_dt = beijing_tz.from_local_datetime(&naive_dt).single()?;
            let utc_dt = beijing_dt.to_utc();

            return Some(utc_dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        }
        
        None
    }
    
    /// Parse timezone offset formats like "2025-10-05T14:23:45+08:00" or "2025-10-05T14:23:45+0800"
    fn parse_timezone_offset_format(&self, timestamp: &str) -> Option<String> {
        // Look for timezone indicators
        let has_plus = timestamp.contains('+');
        let has_minus = timestamp.rfind('-').map(|pos| pos > 10); // Make sure it's not the date separator
        
        if !has_plus && has_minus != Some(true) {
            return None;
        }
        
        // Find the timezone offset position
        let tz_pos = if has_plus {
            timestamp.rfind('+')?
        } else {
            timestamp.rfind('-')?
        };
        
        let datetime_part = &timestamp[..tz_pos];
        let tz_part = &timestamp[tz_pos..];
        
        tracing::debug!("📅 Parsing timezone format - datetime: '{}', timezone: '{}'", datetime_part, tz_part);
        
        // Parse the datetime part
        let naive_dt = chrono::NaiveDateTime::parse_from_str(datetime_part, "%Y-%m-%dT%H:%M:%S").ok()?;
        
        // Parse timezone offset
        let tz_offset_hours = if tz_part.len() >= 3 {
            let sign = if tz_part.starts_with('+') { 1 } else { -1 };
            let offset_str = &tz_part[1..];
            
            // Handle both +08:00 and +0800 formats
            let hours = if offset_str.contains(':') {
                // Format: +08:00
                let parts: Vec<&str> = offset_str.split(':').collect();
                parts[0].parse::<i32>().ok()?
            } else if offset_str.len() >= 4 {
                // Format: +0800
                let hours_str = &offset_str[0..2];
                hours_str.parse::<i32>().ok()?
            } else if offset_str.len() >= 2 {
                // Format: +08
                offset_str.parse::<i32>().ok()?
            } else {
                return None;
            };
            
            sign * hours
        } else {
            return None;
        };
        
        tracing::debug!("📅 Parsed timezone offset: {} hours", tz_offset_hours);
        
        // Create timezone offset and convert to UTC
        let tz_offset = chrono::FixedOffset::east_opt(tz_offset_hours * 3600)?;
        let local_dt = tz_offset.from_local_datetime(&naive_dt).single()?;
        let utc_dt = local_dt.to_utc();

        Some(utc_dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
    }
    
    // Helper functions
    fn extract_modem_id(line: &str) -> Option<String> {
        line.split("/Modem/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .map(|s| s.to_string())
    }
    
    fn extract_sms_id(line: &str) -> Option<String> {
        line.split("/SMS/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .map(|s| s.to_string())
    }
}
