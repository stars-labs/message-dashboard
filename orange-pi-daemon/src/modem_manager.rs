mod discovery;
mod messages;
mod queries;
mod sms_commands;
mod sms_path;
#[cfg(test)]
mod tests;

use crate::at_modem::AtModemManager;
use crate::signal_cache::SignalCache;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

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
    signal_cache: Arc<SignalCache>,
    /// `modem_id` -> AT port, populated at discovery.
    port_cache: Arc<RwLock<HashMap<String, CachedPort>>>,
}

impl Default for ModemManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ModemManager {
    pub fn new() -> Self {
        Self {
            at_modem: Arc::new(AtModemManager::new()),
            signal_cache: Arc::new(SignalCache::new(30)),
            port_cache: Arc::new(RwLock::new(HashMap::new())),
        }
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
    /// per-port lock with SMS work.
    pub async fn voice_command(
        &self,
        modem_id: &str,
        command: &str,
        timeout: std::time::Duration,
    ) -> Result<String> {
        let port = self.get_port(modem_id).await;
        self.at_modem.voice_command(&port, command, timeout).await
    }

    /// Stable USB topology path, e.g. `1-1.4.2.2.2`.
    pub async fn get_usb_path(&self, modem_id: &str) -> Option<String> {
        let port = self.get_port(modem_id).await;
        AtModemManager::usb_topology_for_port(&port)
    }
}
