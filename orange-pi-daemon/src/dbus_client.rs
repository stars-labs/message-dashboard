use anyhow::{anyhow, Result};
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::identifiers::{Iccid, Imei, SimNumber};
pub use crate::native_dbus::DeviceDetails;
use crate::native_dbus::NativeDBusClient;
use crate::types::ModemState;

/// Native D-Bus client; falls back to the `busctl` CLI if native D-Bus is unavailable.
#[derive(Debug)]
pub struct DBusClient {
    native_client: Option<NativeDBusClient>,
    busctl_enabled: bool,
}

impl DBusClient {
    pub async fn new() -> Self {
        let native_client = NativeDBusClient::new().await;
        let has_native = native_client.is_available();

        let busctl_enabled = if has_native {
            false
        } else {
            std::process::Command::new("which")
                .arg("busctl")
                .status()
                .is_ok_and(|s| s.success())
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

    pub fn is_available(&self) -> bool {
        self.native_client.is_some() || self.busctl_enabled
    }

    pub fn is_using_native(&self) -> bool {
        self.native_client.is_some()
    }

    pub fn native_client(&self) -> Option<&NativeDBusClient> {
        self.native_client.as_ref()
    }

    pub async fn list_modems(&self) -> Result<Vec<String>> {
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

        if self.busctl_enabled {
            return self.list_modems_busctl().await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    pub async fn get_modem_state(&self, modem_id: &str) -> Result<ModemState> {
        if let Some(native) = &self.native_client {
            match native.get_modem_state(modem_id).await {
                Ok(state) => return Ok(state),
                Err(e) => {
                    debug!("Native D-Bus failed for modem {}: {}", modem_id, e);
                }
            }
        }

        if self.busctl_enabled {
            return self.get_modem_state_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    pub async fn get_sim_iccid(&self, modem_id: &str) -> Result<Option<Iccid>> {
        if let Some(native) = &self.native_client {
            match native.get_sim_iccid(modem_id).await {
                Ok(iccid) => return Ok(iccid),
                Err(e) => {
                    debug!("Native D-Bus failed for SIM {}: {}", modem_id, e);
                }
            }
        }

        if self.busctl_enabled {
            return self.get_sim_iccid_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<(u32, bool)> {
        if let Some(native) = &self.native_client {
            match native.get_signal_quality(modem_id).await {
                Ok(quality) => return Ok(quality),
                Err(e) => {
                    debug!("Native D-Bus failed for signal {}: {}", modem_id, e);
                }
            }
        }

        if self.busctl_enabled {
            return self.get_signal_quality_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<SimNumber>> {
        if let Some(native) = &self.native_client {
            match native.get_phone_number(modem_id).await {
                Ok(number) => return Ok(number),
                Err(e) => {
                    debug!("Native D-Bus failed for phone number {}: {}", modem_id, e);
                }
            }
        }

        Err(anyhow!("No D-Bus method available for phone number"))
    }

    /// Not implemented for D-Bus; always `None`.
    pub fn get_operator(&self, _modem_id: &str) -> Result<Option<String>> {
        Ok(None)
    }

    pub async fn get_device_details(&self, modem_id: &str) -> Result<DeviceDetails> {
        if let Some(native) = &self.native_client {
            match native.get_device_details(modem_id).await {
                Ok(details) => return Ok(details),
                Err(e) => {
                    debug!("Native D-Bus failed for details {}: {}", modem_id, e);
                }
            }
        }

        if self.busctl_enabled {
            return self.get_device_details_busctl(modem_id).await;
        }

        Err(anyhow!("No D-Bus method available"))
    }

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

        for line in stdout.lines() {
            if let Some(modem_path) = extract_modem_id_from_path(line) {
                modem_ids.push(modem_path);
            }
        }

        debug!("📱 Found {} modems via busctl", modem_ids.len());
        Ok(modem_ids)
    }

    async fn get_modem_state_busctl(&self, modem_id: &str) -> Result<ModemState> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");

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

        let state_code = stdout
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<i32>().ok())
            .ok_or_else(|| anyhow!("Failed to parse modem state"))?;

        Ok(ModemState::from_code(state_code))
    }

    async fn get_sim_iccid_busctl(&self, modem_id: &str) -> Result<Option<Iccid>> {
        let modem_path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");

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

        let sim_path = stdout
            .split('"')
            .nth(1)
            .ok_or_else(|| anyhow!("Failed to parse SIM path"))?;

        if sim_path.is_empty() || sim_path == "/" {
            return Ok(None);
        }

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

        // Trailing 'F' is BCD padding (ITU-T E.118).
        let iccid = stdout
            .split('"')
            .nth(1)
            .map(|s| Iccid::try_from(s.trim_end_matches('F')))
            .transpose()?;

        Ok(iccid)
    }

    async fn get_signal_quality_busctl(&self, modem_id: &str) -> Result<(u32, bool)> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");

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

        // busctl output: `ub 75 true` (percent, recent)
        let mut parts = stdout.split_whitespace();

        if let (Some("ub"), Some(percent), Some(recent)) =
            (parts.next(), parts.next(), parts.next())
        {
            let percent = percent.parse::<u32>().unwrap_or(0);
            let recent = recent == "true";
            Ok((percent, recent))
        } else {
            Err(anyhow!("Failed to parse signal quality"))
        }
    }

    async fn get_device_details_busctl(&self, modem_id: &str) -> Result<DeviceDetails> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");

        let mut imei = None;
        let mut manufacturer = None;
        let mut model = None;
        let mut firmware = None;
        let mut hardware = None;

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
                    imei = Imei::try_from(value).ok();
                }
            }
        }

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

fn extract_modem_id_from_path(line: &str) -> Option<String> {
    if line.contains("/org/freedesktop/ModemManager1/Modem/") {
        if let Some((_, remaining)) = line.split_once("/Modem/") {
            let modem_id = remaining.split([' ', '"']).next().unwrap_or_default();
            if !modem_id.is_empty() {
                return Some(modem_id.to_string());
            }
        }
    }
    None
}
