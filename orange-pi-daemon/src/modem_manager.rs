mod discovery;
mod messages;
mod queries;
mod sms_commands;
mod sms_path;
#[cfg(test)]
mod tests;

use crate::at_modem::AtModemManager;
use crate::signal_cache::SignalCache;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BackendMode {
    AtCommand,
    /// Selected with `USE_DBUS=1`; requires the `ModemManager` service.
    DBus,
}

/// The AT port a modem was discovered on, and the USB device that owned it then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedPort {
    pub port: String,
    pub usb_device: String,
}

impl CachedPort {
    fn discovered(port: String) -> Self {
        let usb_device = AtModemManager::usb_topology_for_port(&port).unwrap_or_default();
        Self { port, usb_device }
    }
}

#[derive(Debug, Clone)]
pub struct ModemManager {
    at_modem: Arc<AtModemManager>,
    /// Only loaded in `DBus` mode.
    dbus_client: Option<Arc<crate::dbus_client::DBusClient>>,
    signal_cache: Arc<SignalCache>,
    /// `modem_id` -> AT port, populated at discovery.
    port_cache: Arc<RwLock<HashMap<String, CachedPort>>>,
    mode: BackendMode,
}

impl ModemManager {
    pub async fn new() -> Self {
        let use_dbus = std::env::var("USE_DBUS").is_ok_and(|v| v == "1");

        let mode = if use_dbus {
            info!("Using D-Bus/ModemManager backend (USE_DBUS=1)");
            BackendMode::DBus
        } else {
            info!("Using direct AT commands backend (default)");
            BackendMode::AtCommand
        };

        let dbus_client = if mode == BackendMode::DBus {
            let client = crate::dbus_client::DBusClient::new().await;
            if !client.is_available() {
                warn!("D-Bus not available but USE_DBUS=1 was set!");
            }
            Some(Arc::new(client))
        } else {
            None
        };

        Self {
            at_modem: Arc::new(AtModemManager::new()),
            dbus_client,
            signal_cache: Arc::new(SignalCache::new(30)),
            port_cache: Arc::new(RwLock::new(HashMap::new())),
            mode,
        }
    }

    pub fn is_available(&self) -> bool {
        match self.mode {
            BackendMode::AtCommand => true, // AT commands always available if ports exist
            BackendMode::DBus => self.dbus_client.as_ref().is_some_and(|c| c.is_available()),
        }
    }

    pub fn is_using_native_dbus(&self) -> bool {
        self.mode == BackendMode::DBus
    }

    pub fn is_using_at_commands(&self) -> bool {
        self.mode == BackendMode::AtCommand
    }

    pub fn get_backend_mode(&self) -> BackendMode {
        self.mode
    }

    /// The AT port serving `modem_id`: the port cached at discovery, falling back to
    /// the conventional path for the ID. Public so the URC reader can locate the
    /// matching MODEM port.
    pub async fn get_port(&self, modem_id: &str) -> String {
        if let Some(cached) = self.port_cache.read().await.get(modem_id) {
            return cached.port.clone();
        }
        AtModemManager::modem_id_to_port(modem_id)
    }

    /// Issue a voice-control AT command on the modem's AT port, sharing the
    /// per-port lock with SMS work. AT backend only.
    pub async fn voice_command(
        &self,
        modem_id: &str,
        command: &str,
        timeout: std::time::Duration,
    ) -> Result<String> {
        if self.mode != BackendMode::AtCommand {
            return Err(anyhow!("voice calls need the AT command backend"));
        }
        let port = self.get_port(modem_id).await;
        self.at_modem.voice_command(&port, command, timeout).await
    }

    /// Stable USB topology path, e.g. `1-1.4.2.2.2`.
    pub async fn get_usb_path(&self, modem_id: &str) -> Option<String> {
        let port = self.get_port(modem_id).await;
        AtModemManager::usb_topology_for_port(&port)
    }
}
