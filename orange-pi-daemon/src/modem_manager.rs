use anyhow::{anyhow, Result};
use crate::types::{Message, MessageWithPath, SignalData};
use crate::dbus_client::DBusClient;
use crate::signal_cache::SignalCache;
use std::sync::Arc;
use tracing::{debug, error};

#[derive(Clone)]
pub struct ModemManager {
    dbus_client: Arc<DBusClient>,
    signal_cache: Arc<SignalCache>,
}

impl ModemManager {
    pub async fn new() -> Self {
        let client = DBusClient::new().await;

        // Ensure D-Bus is available - fail fast if not
        if !client.is_available() {
            error!("❌ D-Bus is not available! ModemManager requires D-Bus to function.");
            error!("💡 Please ensure:");
            error!("   1. D-Bus system daemon is running: systemctl status dbus");
            error!("   2. ModemManager is running: systemctl status ModemManager");
            error!("   3. zbus library can connect to the system bus");
        }

        Self {
            dbus_client: Arc::new(client),
            signal_cache: Arc::new(SignalCache::new(30)), // 30 second cache TTL
        }
    }

    /// Check if D-Bus is available
    pub fn is_available(&self) -> bool {
        self.dbus_client.is_available()
    }

    /// Check if using native D-Bus
    pub async fn is_using_native_dbus(&self) -> bool {
        self.dbus_client.is_using_native()
    }

    /// List all modem IDs (D-Bus only - no fallback)
    pub async fn list_modems(&self) -> Result<Vec<String>> {
        self.dbus_client.list_modems().await
            .map(|modems| {
                debug!("🚀 Listed {} modems via D-Bus", modems.len());
                modems
            })
            .map_err(|e| {
                error!("❌ Failed to list modems via D-Bus: {}", e);
                error!("💡 Ensure ModemManager is running and D-Bus is accessible");
                anyhow!("D-Bus communication failed: {}", e)
            })
    }

    /// Get ICCID for a modem (D-Bus only)
    pub async fn get_iccid(&self, modem_id: &str) -> Result<Option<String>> {
        self.dbus_client.get_sim_iccid(modem_id).await
            .map_err(|e| {
                debug!("Failed to get ICCID for modem {}: {}", modem_id, e);
                e
            })
    }

    /// Get signal quality (cached, D-Bus only)
    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        // Check cache first
        if let Some(cached_signal) = self.signal_cache.get(modem_id).await {
            return Ok(cached_signal);
        }

        // Not in cache, fetch fresh data via D-Bus
        let (percent, _recent) = self.dbus_client.get_signal_quality(modem_id).await?;

        let signal = SignalData {
            percent: percent as i32,
            rssi: (percent as i32 * 120 / 100) - 110,
        };

        // Cache the result
        self.signal_cache.set(modem_id.to_string(), signal.clone()).await;

        Ok(signal)
    }

    /// Get device details (D-Bus only)
    /// Returns None if the modem has no valid IMEI (no SIM or during SIM swap)
    pub async fn get_device_details(&self, modem_id: &str) -> Result<Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)>> {
        let details = self.dbus_client.get_device_details(modem_id).await?;

        // Skip modems without valid IMEI to prevent fake entries
        if details.imei.is_empty() {
            debug!("Modem {} has no valid IMEI, skipping", modem_id);
            return Ok(None);
        }

        Ok(Some((details.imei, details.manufacturer, details.model, details.firmware_version, details.hardware_revision)))
    }

    /// Get phone number (D-Bus only)
    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<String>> {
        self.dbus_client.get_phone_number(modem_id).await
    }

    /// Get operator name (D-Bus only)
    pub async fn get_operator(&self, modem_id: &str) -> Result<Option<String>> {
        self.dbus_client.get_operator(modem_id).await
    }

    /// Get new SMS messages with paths (D-Bus only)
    /// Returns messages WITH their SMS paths for deletion after successful upload
    pub async fn get_new_messages_with_paths(&self, modem_id: &str, iccid: &str) -> Result<Vec<MessageWithPath>> {
        // Use native D-Bus client to list and read SMS
        if let Some(native) = self.dbus_client.native_client() {
            let sms_messages = native.list_sms(modem_id).await?;

            let mut messages_with_paths = Vec::new();
            for sms in sms_messages {
                let message = Message {
                    phone_iccid: iccid.to_string(),
                    phone_number: sms.number,
                    content: sms.text,
                    timestamp: self.normalize_timestamp(&sms.timestamp)?,
                    direction: "received".to_string(),
                };

                messages_with_paths.push(MessageWithPath {
                    message,
                    modem_id: modem_id.to_string(),
                    sms_path: sms.path.clone(),
                });

                // DO NOT DELETE HERE - will delete after successful upload
            }

            Ok(messages_with_paths)
        } else {
            // No D-Bus available - cannot read messages
            Err(anyhow!("D-Bus is required for SMS operations"))
        }
    }

    /// Get new SMS messages (D-Bus only) - DEPRECATED, use get_new_messages_with_paths
    pub async fn get_new_messages(&self, modem_id: &str, iccid: &str) -> Result<Vec<Message>> {
        // For backward compatibility, return just messages without paths
        let messages_with_paths = self.get_new_messages_with_paths(modem_id, iccid).await?;
        Ok(messages_with_paths.into_iter().map(|m| m.message).collect())
    }

    /// Delete SMS after processing (with busctl fallback)
    pub async fn delete_sms(&self, modem_id: &str, sms_path: &str) -> Result<()> {
        // Try native D-Bus first
        if let Some(native) = self.dbus_client.native_client() {
            match native.delete_sms(modem_id, sms_path).await {
                Ok(_) => {
                    debug!("✅ Deleted SMS via native D-Bus: {}", sms_path);
                    return Ok(());
                }
                Err(e) => {
                    debug!("Native D-Bus deletion failed, trying busctl: {}", e);
                }
            }
        }

        // Fallback to busctl command
        debug!("🔧 Attempting busctl fallback deletion for: {}", sms_path);
        let output = tokio::process::Command::new("busctl")
            .arg("call")
            .arg("org.freedesktop.ModemManager1")
            .arg(format!("/org/freedesktop/ModemManager1/Modem/{}", modem_id))
            .arg("org.freedesktop.ModemManager1.Modem.Messaging")
            .arg("Delete")
            .arg("o")
            .arg(sms_path)
            .output()
            .await
            .map_err(|e| anyhow!("Failed to execute busctl: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            error!("busctl deletion failed - stderr: {}, stdout: {}", stderr, stdout);
            return Err(anyhow!("busctl deletion failed: {}", stderr));
        }

        debug!("✅ Deleted SMS via busctl fallback: {}", sms_path);
        Ok(())
    }

    /// Normalize timestamp to RFC3339 UTC format
    fn normalize_timestamp(&self, raw_timestamp: &str) -> Result<String> {
        // First try: Parse as RFC3339 (ISO format with timezone)
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw_timestamp) {
            return Ok(dt.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        }

        // Second try: Parse as naive datetime and assume UTC
        if let Ok(naive_dt) = chrono::NaiveDateTime::parse_from_str(raw_timestamp, "%Y-%m-%dT%H:%M:%S") {
            let dt = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive_dt, chrono::Utc);
            return Ok(dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        }

        // If all else fails, use current time
        Ok(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
    }
}