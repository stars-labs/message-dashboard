use anyhow::{anyhow, Result};
use tokio::process::Command;
use tracing::{debug, info, warn};

// Re-export DeviceDetails so it's accessible from modem_manager
pub use crate::native_dbus::DeviceDetails;
use crate::native_dbus::NativeDBusClient;

/// D-Bus client with native implementation for zero-overhead communication
/// Falls back to busctl CLI if native D-Bus is unavailable
pub struct DBusClient {
    native_client: Option<NativeDBusClient>,
    busctl_enabled: bool,
}

impl DBusClient {
    pub async fn new() -> Self {
        // Try native D-Bus first (best performance)
        let native_client = NativeDBusClient::new().await;
        let has_native = native_client.is_available();

        // Check if busctl is available as fallback
        let busctl_enabled = if !has_native {
            std::process::Command::new("which")
                .arg("busctl")
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        } else {
            false
        };

        if has_native {
            info!("🚀 Native D-Bus client initialized - zero subprocess overhead!");
        } else if busctl_enabled {
            info!("📡 Using busctl D-Bus client - fast subprocess-based fallback");
        } else {
            warn!("⚠️  No D-Bus available! The daemon requires D-Bus to function.");
            warn!("    Please ensure D-Bus and ModemManager are running.");
        }

        Self {
            native_client: if has_native {
                Some(native_client)
            } else {
                None
            },
            busctl_enabled,
        }
    }

    /// Check if any D-Bus method is available
    pub fn is_available(&self) -> bool {
        self.native_client.is_some() || self.busctl_enabled
    }

    /// Check if using native D-Bus (vs busctl fallback)
    pub fn is_using_native(&self) -> bool {
        self.native_client.is_some()
    }

    /// Get native client reference if available
    pub fn native_client(&self) -> Option<&NativeDBusClient> {
        self.native_client.as_ref()
    }

    /// List all modems using D-Bus (native first, then busctl)
    pub async fn list_modems(&self) -> Result<Vec<String>> {
        // Try native D-Bus first
        if let Some(native) = &self.native_client {
            match native.list_modems().await {
                Ok(modems) => {
                    debug!("🚀 Listed {} modems via native D-Bus", modems.len());
                    return Ok(modems);
                }
                Err(e) => {
                    debug!("Native D-Bus failed: {}, trying busctl", e);
                }
            }
        }

        // Fallback to busctl
        if self.busctl_enabled {
            return self.list_modems_busctl().await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    /// Get modem state using D-Bus (native first, then busctl)
    pub async fn get_modem_state(&self, modem_id: &str) -> Result<String> {
        // Try native D-Bus first
        if let Some(native) = &self.native_client {
            match native.get_modem_state(modem_id).await {
                Ok(state) => return Ok(state),
                Err(e) => {
                    debug!("Native D-Bus failed for modem {}: {}", modem_id, e);
                }
            }
        }

        // Fallback to busctl
        if self.busctl_enabled {
            return self.get_modem_state_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    /// Get SIM ICCID using D-Bus (native first, then busctl)
    pub async fn get_sim_iccid(&self, modem_id: &str) -> Result<Option<String>> {
        // Try native D-Bus first
        if let Some(native) = &self.native_client {
            match native.get_sim_iccid(modem_id).await {
                Ok(iccid) => return Ok(iccid),
                Err(e) => {
                    debug!("Native D-Bus failed for SIM {}: {}", modem_id, e);
                }
            }
        }

        // Fallback to busctl
        if self.busctl_enabled {
            return self.get_sim_iccid_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    /// Get signal quality using D-Bus (native first, then busctl)
    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<(u32, bool)> {
        // Try native D-Bus first
        if let Some(native) = &self.native_client {
            match native.get_signal_quality(modem_id).await {
                Ok(quality) => return Ok(quality),
                Err(e) => {
                    debug!("Native D-Bus failed for signal {}: {}", modem_id, e);
                }
            }
        }

        // Fallback to busctl
        if self.busctl_enabled {
            return self.get_signal_quality_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    /// Get phone number using D-Bus (native first, then busctl)
    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<String>> {
        // Try native D-Bus first
        if let Some(native) = &self.native_client {
            match native.get_phone_number(modem_id).await {
                Ok(number) => return Ok(number),
                Err(e) => {
                    debug!("Native D-Bus failed for phone number {}: {}", modem_id, e);
                }
            }
        }

        // Fallback to busctl or mmcli will be handled by ModemManager
        Err(anyhow!("No D-Bus method available for phone number"))
    }

    /// Get operator name using D-Bus
    pub async fn get_operator(&self, _modem_id: &str) -> Result<Option<String>> {
        // This can be retrieved from the SIM or modem status
        // For now, return None or implement if needed
        Ok(None)
    }

    /// Get device details using D-Bus (native first, then busctl)
    pub async fn get_device_details(&self, modem_id: &str) -> Result<DeviceDetails> {
        // Try native D-Bus first
        if let Some(native) = &self.native_client {
            match native.get_device_details(modem_id).await {
                Ok(details) => return Ok(details),
                Err(e) => {
                    debug!("Native D-Bus failed for details {}: {}", modem_id, e);
                }
            }
        }

        // Fallback to busctl
        if self.busctl_enabled {
            return self.get_device_details_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    // ===== BUSCTL FALLBACK METHODS =====

    /// List all modems using busctl
    async fn list_modems_busctl(&self) -> Result<Vec<String>> {
        debug!("🔍 Listing modems via busctl");

        let output = Command::new("busctl")
            .arg("call")
            .arg("org.freedesktop.ModemManager1")
            .arg("/org/freedesktop/ModemManager1")
            .arg("org.freedesktop.DBus.ObjectManager")
            .arg("GetManagedObjects")
            .output()
            .await?;

        if !output.status.success() {
            return Err(anyhow!("Failed to list modems via busctl"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut modem_ids = Vec::new();

        // Parse busctl output to extract modem IDs
        for line in stdout.lines() {
            if let Some(modem_path) = extract_modem_id_from_path(line) {
                modem_ids.push(modem_path);
            }
        }

        debug!("📱 Found {} modems via busctl", modem_ids.len());
        Ok(modem_ids)
    }

    /// Get modem state using busctl
    async fn get_modem_state_busctl(&self, modem_id: &str) -> Result<String> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{}", modem_id);

        let output = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(&path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("State")
            .output()
            .await?;

        if !output.status.success() {
            return Err(anyhow!("Failed to get modem state"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parse state from busctl output
        let state_code = stdout
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<i32>().ok())
            .ok_or_else(|| anyhow!("Failed to parse modem state"))?;

        let state = match state_code {
            -1 => "unknown",
            0 => "failed",
            1 => "unknown",
            2 => "locked",
            3 => "disabled",
            4 => "disabling",
            5 => "enabling",
            6 => "enabled",
            7 => "searching",
            8 => "registered",
            9 => "disconnecting",
            10 => "connecting",
            11 => "connected",
            _ => "unknown",
        };

        Ok(state.to_string())
    }

    /// Get SIM ICCID using busctl
    async fn get_sim_iccid_busctl(&self, modem_id: &str) -> Result<Option<String>> {
        // First get SIM path
        let modem_path = format!("/org/freedesktop/ModemManager1/Modem/{}", modem_id);

        let output = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(&modem_path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("Sim")
            .output()
            .await?;

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parse SIM path from output
        let sim_path = stdout
            .split('"')
            .nth(1)
            .ok_or_else(|| anyhow!("Failed to parse SIM path"))?;

        if sim_path.is_empty() || sim_path == "/" {
            return Ok(None);
        }

        // Now get ICCID from SIM
        let output = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(sim_path)
            .arg("org.freedesktop.ModemManager1.Sim")
            .arg("SimIdentifier")
            .output()
            .await?;

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parse ICCID, stripping trailing 'F' BCD padding (ITU-T E.118)
        let iccid = stdout
            .split('"')
            .nth(1)
            .map(|s| s.trim_end_matches('F').to_string());

        Ok(iccid)
    }

    /// Get signal quality using busctl
    async fn get_signal_quality_busctl(&self, modem_id: &str) -> Result<(u32, bool)> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{}", modem_id);

        let output = Command::new("busctl")
            .arg("call")
            .arg("org.freedesktop.ModemManager1")
            .arg(&path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("GetSignalQuality")
            .output()
            .await?;

        if !output.status.success() {
            return Err(anyhow!("Failed to get signal quality"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parse signal quality from busctl output
        // Format: ub 75 true (percent, recent)
        let parts: Vec<&str> = stdout.split_whitespace().collect();

        if parts.len() >= 3 && parts[0] == "ub" {
            let percent = parts[1].parse::<u32>().unwrap_or(0);
            let recent = parts[2] == "true";
            Ok((percent, recent))
        } else {
            Err(anyhow!("Failed to parse signal quality"))
        }
    }

    /// Get device details using busctl
    async fn get_device_details_busctl(&self, modem_id: &str) -> Result<DeviceDetails> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{}", modem_id);

        let mut imei = String::new();
        let mut manufacturer = None;
        let mut model = None;
        let mut firmware = None;
        let mut hardware = None;

        // Get IMEI
        if let Ok(output) = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(&path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("EquipmentIdentifier")
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(value) = stdout.split('"').nth(1) {
                    imei = value.to_string();
                }
            }
        }

        // Get Manufacturer
        if let Ok(output) = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(&path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("Manufacturer")
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(value) = stdout.split('"').nth(1) {
                    manufacturer = Some(value.to_string());
                }
            }
        }

        // Get Model
        if let Ok(output) = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(&path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("Model")
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(value) = stdout.split('"').nth(1) {
                    model = Some(value.to_string());
                }
            }
        }

        // Get Firmware
        if let Ok(output) = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(&path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("Revision")
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(value) = stdout.split('"').nth(1) {
                    firmware = Some(value.to_string());
                }
            }
        }

        // Get Hardware Revision
        if let Ok(output) = Command::new("busctl")
            .arg("get-property")
            .arg("org.freedesktop.ModemManager1")
            .arg(&path)
            .arg("org.freedesktop.ModemManager1.Modem")
            .arg("HardwareRevision")
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(value) = stdout.split('"').nth(1) {
                    hardware = Some(value.to_string());
                }
            }
        }

        Ok(DeviceDetails {
            imei,
            manufacturer,
            model,
            firmware_version: firmware,
            hardware_revision: hardware,
        })
    }
}

/// Extract modem ID from D-Bus path
fn extract_modem_id_from_path(line: &str) -> Option<String> {
    if line.contains("/org/freedesktop/ModemManager1/Modem/") {
        // Extract the modem ID from the path
        if let Some(start) = line.find("/Modem/") {
            let id_start = start + 7;
            let remaining = &line[id_start..];
            // Find the end (space or quote)
            let end = remaining
                .find(|c: char| c == ' ' || c == '"')
                .unwrap_or(remaining.len());
            let modem_id = &remaining[..end];
            if !modem_id.is_empty() {
                return Some(modem_id.to_string());
            }
        }
    }
    None
}
