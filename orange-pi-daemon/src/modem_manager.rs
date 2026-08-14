//! Modem Manager - Direct AT commands for 100+ modems
//!
//! Uses direct AT commands via serial ports. No ModemManager/D-Bus needed.
//! Set USE_DBUS=1 to use legacy D-Bus mode (requires ModemManager service).

use crate::at_modem::AtModemManager;
use crate::signal_cache::SignalCache;
use crate::types::{Message, MessageWithPath, SignalData};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/// Backend mode
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BackendMode {
    /// Direct AT commands via serial port (default, fastest)
    AtCommand,
    /// D-Bus via ModemManager (legacy, requires ModemManager service)
    DBus,
}

#[cfg(test)]
mod tests {
    use super::ModemManager;

    #[test]
    fn test_format_storage_aware_at_sms_path() {
        let path =
            ModemManager::format_at_sms_path(&[("ME".to_string(), 5), ("SM".to_string(), 7)]);
        assert_eq!(path, "at:ME:5,SM:7");
    }

    #[test]
    fn test_parse_storage_aware_at_sms_path() {
        assert_eq!(
            ModemManager::parse_at_sms_path("at:ME:5,sm:7").unwrap(),
            vec![(Some("ME".to_string()), 5), (Some("SM".to_string()), 7)]
        );
    }

    #[test]
    fn test_parse_legacy_at_sms_path() {
        assert_eq!(
            ModemManager::parse_at_sms_path("at:5,7").unwrap(),
            vec![(None, 5), (None, 7)]
        );
    }

    #[test]
    fn test_parse_at_sms_path_rejects_status_report_storage() {
        assert!(ModemManager::parse_at_sms_path("at:SR:5").is_err());
        assert!(ModemManager::parse_at_sms_path("at:ME:not-a-number").is_err());
        assert!(ModemManager::parse_at_sms_path("at:").is_err());
    }
}

#[derive(Clone)]
pub struct ModemManager {
    /// AT command backend
    at_modem: Arc<AtModemManager>,
    /// D-Bus client (only loaded in DBus mode)
    dbus_client: Option<Arc<crate::dbus_client::DBusClient>>,
    /// Signal quality cache
    signal_cache: Arc<SignalCache>,
    /// Port to modem_id mapping cache
    port_cache: Arc<RwLock<HashMap<String, String>>>,
    /// Backend mode
    mode: BackendMode,
}

impl ModemManager {
    pub async fn new() -> Self {
        // Check mode from environment
        let use_dbus = std::env::var("USE_DBUS").map(|v| v == "1").unwrap_or(false);

        let mode = if use_dbus {
            info!("Using D-Bus/ModemManager backend (USE_DBUS=1)");
            BackendMode::DBus
        } else {
            info!("Using direct AT commands backend (default)");
            BackendMode::AtCommand
        };

        // Only load D-Bus client if needed
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

    /// Check if available
    pub fn is_available(&self) -> bool {
        match self.mode {
            BackendMode::AtCommand => true, // AT commands always available if ports exist
            BackendMode::DBus => self
                .dbus_client
                .as_ref()
                .map(|c| c.is_available())
                .unwrap_or(false),
        }
    }

    /// Check if using native D-Bus
    pub async fn is_using_native_dbus(&self) -> bool {
        self.mode == BackendMode::DBus
    }

    /// Check if using AT commands
    pub async fn is_using_at_commands(&self) -> bool {
        self.mode == BackendMode::AtCommand
    }

    /// Get current backend mode
    pub async fn get_backend_mode(&self) -> BackendMode {
        self.mode
    }

    /// List all modem IDs
    pub async fn list_modems(&self) -> Result<Vec<String>> {
        match self.mode {
            BackendMode::AtCommand => {
                let ports = self.at_modem.discover_modems().await?;
                let mut cache = self.port_cache.write().await;
                cache.clear();

                let modem_ids: Vec<String> = ports
                    .iter()
                    .map(|port| {
                        let id = AtModemManager::port_to_modem_id(port);
                        cache.insert(id.clone(), port.clone());
                        id
                    })
                    .collect();

                debug!("Listed {} modems via AT commands", modem_ids.len());
                Ok(modem_ids)
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                client.list_modems().await
            }
        }
    }

    /// Find modems that are NOT already active and bring them online, merging them into
    /// the port cache. For a candidate AT port that is silent, attempt one USB reset +
    /// re-probe (recovers modems wedged at the USB level). Returns the modem_ids added.
    ///
    /// Deliberately skips modems already in `known` or the cache: re-probing a healthy,
    /// busy modem could collide with the reader loop on the serial port and trigger a
    /// needless reset. The serial probes/resets run WITHOUT holding the cache lock so
    /// the reader's `get_port` is never blocked; the lock is taken only to insert.
    ///
    /// AT-command mode only; in D-Bus mode ModemManager handles its own hotplug.
    pub async fn rediscover_and_merge(
        &self,
        known: &std::collections::HashSet<String>,
    ) -> Result<Vec<String>> {
        if self.mode != BackendMode::AtCommand {
            return Ok(Vec::new());
        }

        // Snapshot ports already served (so we skip whole devices that are working).
        let active_ports: std::collections::HashSet<String> = {
            let cache = self.port_cache.read().await;
            cache.values().cloned().collect()
        };

        // Walk each physical modem (USB device); skip ones that already have a working
        // port. For the rest, probe ports in order to find AT; if all are silent, try a
        // USB reset on the first port then re-probe. Holds no lock during serial I/O.
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
            // All ports silent — attempt a USB reset on the first port, then re-probe.
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
            cache.insert(id, port);
        }
        if reset_recovered > 0 {
            info!(
                "Recovered {} wedged modem(s) via USB reset",
                reset_recovered
            );
        }
        Ok(added)
    }

    /// Get port for modem ID
    async fn get_port(&self, modem_id: &str) -> String {
        if let Some(port) = self.port_cache.read().await.get(modem_id) {
            return port.clone();
        }
        AtModemManager::modem_id_to_port(modem_id)
    }

    /// Get the stable USB topology path (e.g. `1-1.4.2.2.2`) for a modem ID.
    pub async fn get_usb_path(&self, modem_id: &str) -> Option<String> {
        let port = self.get_port(modem_id).await;
        AtModemManager::usb_topology_for_port(&port)
    }

    /// Get ICCID
    pub async fn get_iccid(&self, modem_id: &str) -> Result<Option<String>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                self.at_modem.get_iccid(&port).await
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                client.get_sim_iccid(modem_id).await
            }
        }
    }

    /// Get signal quality (cached)
    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        // Check cache first
        if let Some(cached) = self.signal_cache.get(modem_id).await {
            return Ok(cached);
        }

        let signal = match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                let percent = self.at_modem.get_signal(&port).await?;
                SignalData {
                    percent: percent as i32,
                    rssi: (percent as i32 * 120 / 100) - 110,
                }
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                let (percent, _) = client.get_signal_quality(modem_id).await?;
                SignalData {
                    percent: percent as i32,
                    rssi: (percent as i32 * 120 / 100) - 110,
                }
            }
        };

        self.signal_cache
            .set(modem_id.to_string(), signal.clone())
            .await;
        Ok(signal)
    }

    /// Get device details
    pub async fn get_device_details(
        &self,
        modem_id: &str,
    ) -> Result<
        Option<(
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )>,
    > {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                let info = self.at_modem.get_modem_info(&port).await?;

                if let Some(imei) = info.imei {
                    if !imei.is_empty() {
                        return Ok(Some((
                            imei,
                            info.manufacturer,
                            info.model,
                            info.revision,
                            None,
                        )));
                    }
                }
                debug!("Modem {} has no valid IMEI", modem_id);
                Ok(None)
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                let details = client.get_device_details(modem_id).await?;

                if details.imei.is_empty() {
                    return Ok(None);
                }
                Ok(Some((
                    details.imei,
                    details.manufacturer,
                    details.model,
                    details.firmware_version,
                    details.hardware_revision,
                )))
            }
        }
    }

    /// Get phone number
    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<String>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                self.at_modem.get_phone_number(&port).await
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                client.get_phone_number(modem_id).await
            }
        }
    }

    /// Get operator name
    pub async fn get_operator(&self, modem_id: &str) -> Result<Option<String>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                self.at_modem.get_operator(&port).await
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                client.get_operator(modem_id).await
            }
        }
    }

    /// Health check for a modem (diagnostic)
    pub async fn health_check(
        &self,
        modem_id: &str,
    ) -> Result<Option<crate::at_modem::ModemHealth>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                let health = self.at_modem.health_check(&port).await?;
                Ok(Some(health))
            }
            BackendMode::DBus => {
                info!("Health check not implemented for D-Bus mode");
                Ok(None)
            }
        }
    }

    /// Get new SMS messages with paths/indices
    /// Handles multipart message assembly across polling cycles using persistent storage
    pub async fn get_new_messages_with_paths(
        &self,
        modem_id: &str,
        iccid: &str,
        message_store: &crate::message_store::MessageStore,
    ) -> Result<Vec<MessageWithPath>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                let sms_list = self.at_modem.list_sms(&port).await?;

                // Group multipart messages by (sender, ref_id, total_parts)
                // Messages with concat_info are buffered, messages without are returned immediately
                let mut multipart_groups: HashMap<(String, u8, u8), Vec<crate::at_modem::AtSms>> =
                    HashMap::new();
                let mut complete_messages: Vec<MessageWithPath> = Vec::new();

                for sms in sms_list {
                    if let Some(ref concat_info) = sms.concat_info {
                        // This is part of a multipart message - buffer it
                        let key = (
                            sms.sender.clone(),
                            concat_info.ref_id,
                            concat_info.total_parts,
                        );
                        multipart_groups
                            .entry(key)
                            .or_insert_with(Vec::new)
                            .push(sms);
                    } else {
                        // Single-part message - convert immediately
                        complete_messages.push(MessageWithPath {
                            message: Message {
                                phone_iccid: iccid.to_string(),
                                phone_number: sms.sender,
                                content: sms.text,
                                timestamp: sms.timestamp,
                                direction: "received".to_string(),
                            },
                            modem_id: modem_id.to_string(),
                            sms_path: Self::format_at_sms_path(&[(sms.storage, sms.index)]),
                        });
                    }
                }

                // Process multipart groups with persistent buffering
                for ((sender, ref_id, total_parts), parts) in multipart_groups {
                    // Store new parts to database
                    for part in &parts {
                        let concat_info = part.concat_info.as_ref().unwrap();
                        if let Err(e) = message_store.store_segment_in_storage(
                            iccid,
                            &sender,
                            ref_id,
                            total_parts,
                            concat_info.part_number,
                            &part.text,
                            &part.timestamp,
                            &part.storage,
                            part.index,
                        ) {
                            warn!("Failed to store segment: {}", e);
                        }
                    }

                    // Check if all parts are now available (including previously buffered ones)
                    match message_store.get_segments_with_storage(
                        iccid,
                        &sender,
                        ref_id,
                        total_parts,
                    ) {
                        Ok(segments) if segments.len() == total_parts as usize => {
                            // All parts present - assemble!
                            let mut all_parts: Vec<(u8, String, String, String, u32)> = segments;
                            all_parts.sort_by_key(|(part_num, _, _, _, _)| *part_num);

                            let combined_text = all_parts
                                .iter()
                                .map(|(_, content, _, _, _)| content.as_str())
                                .collect::<Vec<_>>()
                                .join("");
                            let timestamp = all_parts[0].2.clone();
                            let all_locations: Vec<(String, u32)> = all_parts
                                .iter()
                                .map(|(_, _, _, storage, index)| (storage.clone(), *index))
                                .collect();

                            info!(
                                "✅ Assembled multipart message: {} parts, {} chars, ref_id={} from {}",
                                all_parts.len(), combined_text.len(), ref_id, sender
                            );

                            complete_messages.push(MessageWithPath {
                                message: Message {
                                    phone_iccid: iccid.to_string(),
                                    phone_number: sender.clone(),
                                    content: combined_text,
                                    timestamp,
                                    direction: "received".to_string(),
                                },
                                modem_id: modem_id.to_string(),
                                sms_path: Self::format_at_sms_path(&all_locations),
                            });

                            // Delete assembled segments from buffer
                            if let Err(e) = message_store.delete_segments(iccid, ref_id) {
                                warn!("Failed to delete segments: {}", e);
                            }
                        }
                        Ok(segments) => {
                            // Still incomplete - parts buffered in database
                            debug!(
                                "Buffering multipart message: {}/{} parts for ref_id={} from {}",
                                segments.len(),
                                total_parts,
                                ref_id,
                                sender
                            );
                        }
                        Err(e) => {
                            warn!("Failed to check buffered segments: {}", e);
                        }
                    }
                }

                debug!(
                    "Got {} messages via AT from {} (after multipart assembly)",
                    complete_messages.len(),
                    modem_id
                );
                Ok(complete_messages)
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                let native = client
                    .native_client()
                    .ok_or_else(|| anyhow!("Native D-Bus not available"))?;
                let sms_messages = native.list_sms(modem_id).await?;

                let messages: Vec<MessageWithPath> = sms_messages
                    .into_iter()
                    .map(|sms| MessageWithPath {
                        message: Message {
                            phone_iccid: iccid.to_string(),
                            phone_number: sms.number,
                            content: sms.text,
                            timestamp: self.normalize_timestamp(&sms.timestamp),
                            direction: "received".to_string(),
                        },
                        modem_id: modem_id.to_string(),
                        sms_path: sms.path,
                    })
                    .collect();

                Ok(messages)
            }
        }
    }

    /// Get new SMS messages (deprecated)
    pub async fn get_new_messages(
        &self,
        modem_id: &str,
        iccid: &str,
        message_store: &crate::message_store::MessageStore,
    ) -> Result<Vec<Message>> {
        let messages_with_paths = self
            .get_new_messages_with_paths(modem_id, iccid, message_store)
            .await?;
        Ok(messages_with_paths.into_iter().map(|m| m.message).collect())
    }

    /// Delete SMS
    pub async fn delete_sms(&self, modem_id: &str, sms_path: &str) -> Result<()> {
        match self.mode {
            BackendMode::AtCommand => {
                let locations = Self::parse_at_sms_path(sms_path)?;

                let port = self.get_port(modem_id).await;
                for (storage, index) in locations {
                    if let Some(storage) = storage {
                        self.at_modem
                            .delete_sms_from_storage(&port, &storage, index)
                            .await?;
                        debug!("Deleted SMS {}:{} via AT from {}", storage, index, modem_id);
                    } else {
                        // Backward compatibility for rows created before storage-aware paths.
                        self.at_modem.delete_sms(&port, index).await?;
                        debug!("Deleted legacy SMS {} via AT from {}", index, modem_id);
                    }
                }
                Ok(())
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                if let Some(native) = client.native_client() {
                    native.delete_sms(modem_id, sms_path).await?;
                    debug!("Deleted SMS via D-Bus: {}", sms_path);
                    Ok(())
                } else {
                    Err(anyhow!("Native D-Bus not available for deletion"))
                }
            }
        }
    }

    fn format_at_sms_path(locations: &[(String, u32)]) -> String {
        let encoded = locations
            .iter()
            .map(|(storage, index)| format!("{}:{}", storage.to_ascii_uppercase(), index))
            .collect::<Vec<_>>()
            .join(",");
        format!("at:{}", encoded)
    }

    /// Parse both storage-aware `at:ME:5,SM:7` paths and legacy `at:5,7` paths.
    fn parse_at_sms_path(sms_path: &str) -> Result<Vec<(Option<String>, u32)>> {
        let encoded = sms_path
            .strip_prefix("at:")
            .ok_or_else(|| anyhow!("Invalid AT SMS path: {}", sms_path))?;
        if encoded.is_empty() {
            return Err(anyhow!("AT SMS path contains no locations: {}", sms_path));
        }

        encoded
            .split(',')
            .map(|location| {
                if let Some((storage, index)) = location.split_once(':') {
                    let storage = storage.to_ascii_uppercase();
                    if !matches!(storage.as_str(), "ME" | "SM" | "MT") {
                        return Err(anyhow!("Invalid SMS storage in path: {}", storage));
                    }
                    let index = index
                        .parse::<u32>()
                        .map_err(|_| anyhow!("Invalid SMS index: {}", index))?;
                    Ok((Some(storage), index))
                } else {
                    let index = location
                        .parse::<u32>()
                        .map_err(|_| anyhow!("Invalid SMS index: {}", location))?;
                    Ok((None, index))
                }
            })
            .collect()
    }

    /// Send SMS
    pub async fn send_sms(&self, modem_id: &str, recipient: &str, content: &str) -> Result<()> {
        self.send_sms_with_short_code(modem_id, recipient, content, false)
            .await
    }

    /// Send SMS, optionally allowing a carrier service short code.
    pub async fn send_sms_with_short_code(
        &self,
        modem_id: &str,
        recipient: &str,
        content: &str,
        allow_short_code: bool,
    ) -> Result<()> {
        // Single choke point for outbound sends, so both backends get the same
        // guarantee. The AT backend interpolates these into serial command strings
        // where a CR is an injection (docs/SECURITY-REVIEW.md finding 3); the D-Bus
        // backend passes them as typed arguments and is not injectable, but there is no
        // reason to accept a malformed number on either path.
        AtModemManager::validate_recipient_with_short_code(recipient, allow_short_code)?;
        AtModemManager::validate_message_body(content)?;

        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                self.at_modem
                    .send_sms_with_short_code(&port, recipient, content, allow_short_code)
                    .await?;
                info!("Sent SMS via AT from modem {} to {}", modem_id, recipient);
                Ok(())
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                if let Some(native) = client.native_client() {
                    native.send_sms(modem_id, recipient, content).await?;
                    info!(
                        "Sent SMS via D-Bus from modem {} to {}",
                        modem_id, recipient
                    );
                    Ok(())
                } else {
                    Err(anyhow!("Native D-Bus not available for sending SMS"))
                }
            }
        }
    }

    /// Normalize timestamp
    fn normalize_timestamp(&self, raw: &str) -> String {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
            return dt
                .with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
        }
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
            let dt = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc);
            return dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        }
        chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }
}
