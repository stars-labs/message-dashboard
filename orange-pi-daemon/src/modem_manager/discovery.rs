use super::{CachedPort, ModemManager};
use crate::at_modem::AtModemManager;
use anyhow::Result;
use std::collections::{BTreeMap, HashMap, HashSet};
use tracing::{debug, info, warn};

/// Keep a cached modem only while its port still belongs to the USB device it
/// was discovered on.
///
/// A port path alone is not enough: when the kernel re-enumerates a bus, ttyUSB
/// numbers are handed out afresh, so a cached AT port path can come back as the
/// DIAG port of a different modem, and rediscovery would skip that modem because
/// one of its ports is "already in use".
pub(super) fn retain_present_cached_modems(
    cache: &mut HashMap<String, CachedPort>,
    groups: &BTreeMap<String, Vec<String>>,
) {
    cache.retain(|_, cached| {
        groups
            .get(&cached.usb_device)
            .is_some_and(|ports| ports.contains(&cached.port))
    });
}

impl ModemManager {
    pub async fn list_modems(&self) -> Result<Vec<String>> {
        let ports = self.at_modem.discover_modems().await?;
        let mut cache = self.port_cache.write().await;
        cache.clear();

        let modem_ids: Vec<String> = ports
            .iter()
            .map(|port| {
                let id = AtModemManager::port_to_modem_id(port);
                cache.insert(id.clone(), CachedPort::discovered(port.clone()));
                id
            })
            .collect();

        debug!("Listed {} modems via AT commands", modem_ids.len());
        Ok(modem_ids)
    }

    /// Bring modems that are not already active online, merging them into the port
    /// cache. A silent device gets one USB reset and re-probe. Returns the `modem_ids`
    /// added.
    ///
    /// Modems already in `known` or the cache are skipped: re-probing a busy modem could
    /// collide with the reader loop on the serial port and trigger a needless reset.
    /// Serial probes run without the cache lock so the reader's `get_port` never blocks.
    pub async fn rediscover_and_merge(&self, known: &HashSet<String>) -> Result<Vec<String>> {
        let active_ports: HashSet<String> = {
            let cache = self.port_cache.read().await;
            cache.values().map(|cached| cached.port.clone()).collect()
        };

        let mut found: Vec<(String, String)> = Vec::new();
        let mut reset_recovered = 0;
        for (_dev, dev_ports) in AtModemManager::ttyusb_by_usb_device()? {
            if dev_ports.iter().any(|p| active_ports.contains(p)) {
                continue; // this modem is already online — don't touch it
            }

            let probe_order = AtModemManager::at_probe_order(&dev_ports);
            let mut at_port: Option<String> = None;
            for p in &probe_order {
                if self.at_modem.probe_port(p).await {
                    at_port = Some(p.clone());
                    break;
                }
            }
            if at_port.is_none() {
                if let Some(first) = dev_ports.first() {
                    match self.at_modem.reset_usb_port(first).await {
                        Ok(true) => {
                            reset_recovered += 1;
                            for p in &probe_order {
                                if self.at_modem.probe_port(p).await {
                                    at_port = Some(p.clone());
                                    break;
                                }
                            }
                        }
                        Ok(false) => {}
                        Err(e) => debug!("Cannot reset {}: {}", first, e),
                    }
                }
            }

            if let Some(port) = at_port {
                let id = AtModemManager::port_to_modem_id(&port);
                if !known.contains(&id) {
                    let _ = self.at_modem.init_ims(&port).await;
                    let _ = self.at_modem.init_urc_port(&port).await;
                    found.push((id, port));
                }
            }
        }

        if found.is_empty() {
            return Ok(Vec::new());
        }

        let mut cache = self.port_cache.write().await;
        let mut added = Vec::new();
        for (id, port) in found {
            if !cache.contains_key(&id) {
                added.push(id.clone());
            }
            cache.insert(id, CachedPort::discovered(port));
        }
        if reset_recovered > 0 {
            info!(
                "Recovered {} wedged modem(s) via USB reset",
                reset_recovered
            );
        }
        Ok(added)
    }

    /// Reconcile the live modem handles against USB enumeration, then probe only
    /// newly enumerated devices. Existing devices are never re-probed here, so
    /// this cannot collide with the reader's normal AT traffic.
    pub async fn reconcile_modems(&self) -> Result<Vec<String>> {
        let groups = AtModemManager::ttyusb_by_usb_device()?;
        {
            let mut cache = self.port_cache.write().await;
            let before = cache.len();
            retain_present_cached_modems(&mut cache, &groups);
            if cache.len() < before {
                info!(
                    "🔎 Dropped {} cached modems whose port moved to another USB device",
                    before - cache.len()
                );
            }
        }

        let known: HashSet<String> = self.port_cache.read().await.keys().cloned().collect();
        self.rediscover_and_merge(&known).await?;

        let mut current: Vec<String> = self.port_cache.read().await.keys().cloned().collect();
        current.sort_by_key(|id| id.parse::<u32>().unwrap_or(u32::MAX));
        Ok(current)
    }

    /// Drop a modem from the cache so the next reconcile probes its USB device
    /// again, including the USB reset that rediscovery applies to a silent one.
    pub async fn forget_modem(&self, modem_id: &str) {
        if let Some(cached) = self.port_cache.write().await.remove(modem_id) {
            warn!(
                "🔎 Forgetting modem {} on {} after repeated timeouts; it will be re-probed",
                modem_id, cached.port
            );
        }
    }
}
