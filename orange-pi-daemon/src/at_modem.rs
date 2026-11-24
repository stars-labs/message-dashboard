//! Direct AT access to Quectel EC20 modems, bypassing `ModemManager`.
//! Default composition per modem: DIAG, NMEA, AT, MODEM (ttyUSB0..3).

mod discovery;
mod pdu;
mod queries;
mod serial;
mod sms_list;
mod sms_send;
mod sms_text;
mod usb_reset;

#[cfg(test)]
mod tests;

use crate::identifiers::{Iccid, Imei, SimNumber, SmsAddress};
use crate::types::SmsStorage;
use anyhow::{anyhow, Result};
use nix::sys::termios;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone)]
pub struct AtSms {
    /// CPMS mem1 storage containing this message; unset until the scan that found it records it.
    pub storage: Option<SmsStorage>,
    pub index: u32,
    /// All SIM indices that belong to this logical message (concatenated parts)
    pub part_indices: Vec<u32>,
    pub sender: SmsAddress,
    pub timestamp: String,
    pub text: String,
    pub concat_info: Option<ConcatInfo>,
}

#[derive(Debug, Clone)]
pub struct ConcatInfo {
    pub ref_id: u8,
    pub total_parts: u8,
    /// 1-indexed
    pub part_number: u8,
}

#[derive(Debug, Clone, Default)]
pub struct AtModemInfo {
    pub port: String,
    pub iccid: Option<Iccid>,
    pub imei: Option<Imei>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub revision: Option<String>,
    pub signal_percent: Option<u32>,
    pub phone_number: Option<SimNumber>,
    pub operator: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NetworkRegStatus {
    /// (n, stat); stat: 0=not reg, 1=reg home, 2=searching, 3=denied, 4=unknown, 5=roaming
    pub creg: (u32, u32),
    pub cgreg: (u32, u32),
}

#[derive(Debug, Clone, Default)]
pub struct ImsStatus {
    pub enabled: bool,
    pub registration: String,
}

/// `AT+CMGF` message format.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SmsMode {
    #[default]
    Unknown,
    Pdu,
    Text,
}

impl std::fmt::Display for SmsMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unknown => "Unknown",
            Self::Pdu => "PDU",
            Self::Text => "Text",
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct SmsConfig {
    pub mode: SmsMode,
    pub storage: String,
}

#[derive(Debug, Clone, Default)]
pub struct ModemHealth {
    pub port: String,
    pub iccid: Option<Iccid>,
    pub imei: Option<Imei>,
    pub signal_percent: Option<u32>,
    pub operator: Option<String>,
    pub network_reg: Option<NetworkRegStatus>,
    pub ims_status: Option<ImsStatus>,
    pub sms_center: Option<String>,
    pub sms_config: Option<SmsConfig>,
}

/// Serial ports a voice call needs besides the AT port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoicePorts {
    /// Interface 1: 8 kHz PCM once `AT+QPCMV=1,0` is set.
    pub nmea: String,
    /// Interface 3: URCs once `init_urc_port` has run.
    pub modem: String,
}

#[derive(Debug)]
pub struct AtModemManager {
    modems: Arc<RwLock<HashMap<String, AtModemInfo>>>,
    /// One lock per AT port. A complete SMS submission holds this lock so the reader
    /// cannot flush or consume the modem prompt between configuration and CMGS.
    port_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    timeout: Duration,
}

#[expect(
    clippy::as_conversions,
    reason = "nix declares SpecialCharacterIndices as a repr(usize) enum with no conversion to usize, and termios::control_chars is indexed by usize"
)]
pub fn control_char_slot(index: termios::SpecialCharacterIndices) -> usize {
    index as usize
}

fn read_chunk(buf: &[u8], n: usize) -> Result<&[u8]> {
    buf.get(..n)
        .ok_or_else(|| anyhow!("read reported {n} bytes into a {}-byte buffer", buf.len()))
}

pub fn set_control_char(
    term: &mut termios::Termios,
    index: termios::SpecialCharacterIndices,
    value: u8,
) -> Result<()> {
    let slot = term
        .control_chars
        .get_mut(control_char_slot(index))
        .ok_or_else(|| anyhow!("termios control character slot is out of range"))?;
    *slot = value;
    Ok(())
}

impl Default for AtModemManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AtModemManager {
    pub fn new() -> Self {
        Self {
            modems: Arc::new(RwLock::new(HashMap::new())),
            port_locks: Mutex::new(HashMap::new()),
            timeout: Duration::from_secs(5),
        }
    }

    async fn port_lock(&self, port: &str) -> Arc<Mutex<()>> {
        let mut locks = self.port_locks.lock().await;
        locks
            .entry(port.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn get_modem_info(&self, port: &str) -> Result<AtModemInfo> {
        let mut info = AtModemInfo {
            port: port.to_string(),
            ..Default::default()
        };

        info.imei = self.get_imei(port).await.unwrap_or(None);
        info.iccid = self.get_iccid(port).await.unwrap_or(None);
        info.manufacturer = self.get_manufacturer(port).await.unwrap_or(None);
        info.model = self.get_model(port).await.unwrap_or(None);
        info.revision = self.get_revision(port).await.unwrap_or(None);
        info.signal_percent = self.get_signal(port).await.ok();
        info.phone_number = self.get_phone_number(port).await.unwrap_or(None);
        info.operator = self.get_operator(port).await.unwrap_or(None);

        self.modems
            .write()
            .await
            .insert(port.to_string(), info.clone());

        Ok(info)
    }

    /// The modem ID is the AT port's ttyUSB index ("/dev/ttyUSB6" -> "6"), an internal
    /// handle; the stable cross-system key is the IMEI (`equipment_id`).
    pub fn port_to_modem_id(port: &str) -> String {
        port.strip_prefix("/dev/ttyUSB")
            .map_or_else(|| port.to_string(), ToString::to_string)
    }

    pub fn modem_id_to_port(id: &str) -> String {
        if id.parse::<u32>().is_ok() {
            return format!("/dev/ttyUSB{id}");
        }
        id.to_string()
    }
}
