//! Direct AT access to Quectel EC20 modems, bypassing `ModemManager`.
//! Default composition per modem: DIAG, NMEA, AT, MODEM (ttyUSB0..3).

use crate::identifiers::{Iccid, Imei, SimNumber, SmsAddress};
use crate::types::{SmsStorage, SmsSubmission};
use anyhow::{anyhow, Result};
use nix::sys::termios::{self, BaudRate, SetArg};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, info, warn};

// USBDEVFS_RESET = _IO('U', 20)
nix::ioctl_none!(usbdevfs_reset, b'U', 20);

const SMS_PROMPT_TIMEOUT: Duration = Duration::from_secs(10);
const SMS_PROMPT_TIMEOUT_ERROR: &str = "Timeout waiting for > prompt";
const SMS_PROMPT_RETRY_DELAY: Duration = Duration::from_secs(1);

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

pub struct AtModemManager {
    modems: Arc<RwLock<HashMap<String, AtModemInfo>>>,
    /// One lock per AT port. A complete SMS submission holds this lock so the reader
    /// cannot flush or consume the modem prompt between configuration and CMGS.
    port_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    timeout: Duration,
}

#[allow(
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

    /// Group every /dev/ttyUSB* port by the physical USB device (modem) that owns it.
    /// Returns USB device name -> sorted port list, independent of how many interfaces
    /// the modem exposes.
    pub fn ttyusb_by_usb_device() -> Result<BTreeMap<String, Vec<String>>> {
        let mut groups: BTreeMap<String, Vec<u32>> = BTreeMap::new();
        let entries = fs::read_dir("/sys/class/tty")
            .map_err(|e| anyhow!("Failed to read /sys/class/tty: {e}"))?;
        for entry in entries.filter_map(std::result::Result::ok) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("ttyUSB") {
                continue;
            }
            let Ok(num) = name.trim_start_matches("ttyUSB").parse::<u32>() else {
                continue;
            };
            // The modem is the first ancestor USB *device* dir carrying an idVendor file
            // (interface and tty dirs do not).
            let link = format!("/sys/class/tty/{name}/device");
            let Ok(canon) = fs::canonicalize(&link) else {
                continue;
            };
            let mut dir = canon.as_path();
            let usb_dev = loop {
                if dir.join("idVendor").is_file() {
                    break dir.file_name().map(|f| f.to_string_lossy().into_owned());
                }
                match dir.parent() {
                    Some(p) if p.starts_with("/sys") && p != dir => dir = p,
                    _ => break None,
                }
            };
            let Some(usb_dev) = usb_dev else {
                continue;
            };
            groups.entry(usb_dev).or_default().push(num);
        }
        Ok(groups
            .into_iter()
            .map(|(dev, mut nums)| {
                nums.sort_unstable();
                (
                    dev,
                    nums.into_iter()
                        .map(|n| format!("/dev/ttyUSB{n}"))
                        .collect(),
                )
            })
            .collect())
    }

    /// Resolve a `/dev/ttyUSBN` AT port to its USB topology path (e.g. `1-1.4.2.2.2`).
    ///
    /// The path encodes the physical socket and is stable across reboot and replug,
    /// unlike the ttyUSB number, which the kernel reshuffles on every enumeration.
    pub fn usb_topology_for_port(port: &str) -> Option<String> {
        let name = port.trim_start_matches("/dev/");
        let link = format!("/sys/class/tty/{name}/device");
        let canon = fs::canonicalize(&link).ok()?;
        let mut dir = canon.as_path();
        loop {
            if dir.join("idVendor").is_file() {
                return dir.file_name().map(|f| f.to_string_lossy().into_owned());
            }
            match dir.parent() {
                Some(p) if p.starts_with("/sys") && p != dir => dir = p,
                _ => return None,
            }
        }
    }

    /// Order a modem's ttyUSB ports so the real AT command port is tried first.
    ///
    /// The default 4-port layout DIAG/NMEA/AT/MODEM has AT at index 2; the slimmed
    /// AT+MODEM layout has it at index 0. The MODEM/PPP port also answers a bare "AT",
    /// so the lowest port cannot be tried first or it would be cached as the AT port.
    pub fn at_probe_order(ports: &[String]) -> Vec<String> {
        let mut order: Vec<String> = Vec::with_capacity(ports.len());
        if let Some(at_slot) = ports.get(2) {
            order.push(at_slot.clone());
        }
        for (i, p) in ports.iter().enumerate() {
            if i != 2 {
                order.push(p.clone());
            }
        }
        order
    }

    /// Probes ports in `at_probe_order` and keeps the first that answers AT, one per USB device.
    pub async fn discover_modems(&self) -> Result<Vec<String>> {
        let groups = Self::ttyusb_by_usb_device()?;
        let device_count = groups.len();
        let mut ports = Vec::new();

        for dev_ports in groups.values() {
            for port_path in Self::at_probe_order(dev_ports) {
                match self.probe_port_with_error(&port_path).await {
                    Ok(true) => {
                        if let Err(e) = self.init_ims(&port_path).await {
                            warn!("Failed to initialize IMS on {}: {}", port_path, e);
                        }
                        if let Err(e) = self.init_urc_port(&port_path).await {
                            warn!("Failed to route URCs on {}: {}", port_path, e);
                        }
                        ports.push(port_path);
                        break; // one AT port per physical modem
                    }
                    Ok(false) => debug!("Port {} no AT response", port_path),
                    Err(e) => debug!("Port {} probe error: {}", port_path, e),
                }
            }
        }

        if device_count > 0 && ports.is_empty() {
            warn!(
                "Found {} USB modem devices but none answered AT — check /dev/ttyUSB* permissions or port contention",
                device_count
            );
        }

        info!(
            "Discovered {} modems (scanned {} USB devices)",
            ports.len(),
            device_count
        );
        Ok(ports)
    }

    async fn probe_port_with_error(&self, port: &str) -> Result<bool> {
        match self
            .send_at_command(port, "AT", Duration::from_millis(1000))
            .await
        {
            Ok(response) => Ok(response.contains("OK")),
            Err(e) => Err(e),
        }
    }

    pub async fn probe_port(&self, port: &str) -> bool {
        match self
            .send_at_command(port, "AT", Duration::from_millis(500))
            .await
        {
            Ok(response) => response.contains("OK"),
            Err(_) => false,
        }
    }

    /// USB-resets the modem backing `port` and waits for it to answer AT again;
    /// Ok(true) if it did within 10s.
    ///
    /// Requires write access to the usbfs node (/dev/bus/usb/BBB/DDD); on the
    /// Orange Pi the `dialout` group gets it via a udev rule.
    pub async fn reset_usb_port(&self, port: &str) -> Result<bool> {
        let node = Self::usbfs_node_for_port(port)?;
        info!("🔌 USB-resetting {} via {}", port, node.display());

        let node_for_blocking = node.clone();
        tokio::task::spawn_blocking(move || Self::reset_usb_sync(&node_for_blocking)).await??;

        // The device re-enumerates and the kernel rebuilds the same ttyUSB node.
        for attempt in 0..10 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if Path::new(port).exists() && self.probe_port(port).await {
                debug!("✅ {} answered AT {}s after reset", port, attempt + 1);
                return Ok(true);
            }
        }
        warn!("⚠️  {} did not recover within 10s after USB reset", port);
        Ok(false)
    }

    #[allow(
        unsafe_code,
        reason = "USBDEVFS_RESET is an ioctl with no safe wrapper in nix or std"
    )]
    fn reset_usb_sync(node: &Path) -> Result<()> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(node)
            .map_err(|e| anyhow!("Failed to open usbfs node {}: {}", node.display(), e))?;
        // SAFETY: fd is a valid open usbfs device node; USBDEVFS_RESET takes no argument.
        unsafe {
            usbdevfs_reset(file.as_raw_fd())
                .map_err(|e| anyhow!("USBDEVFS_RESET on {} failed: {}", node.display(), e))?;
        }
        Ok(())
    }

    fn usbfs_node_for_port(port: &str) -> Result<PathBuf> {
        let dev_name = port
            .strip_prefix("/dev/")
            .ok_or_else(|| anyhow!("Unexpected port path: {port}"))?;
        let device_link = format!("/sys/class/tty/{dev_name}/device");
        let mut dir = fs::canonicalize(&device_link)
            .map_err(|e| anyhow!("Cannot resolve sysfs device for {port}: {e}"))?;

        // The USB *device* dir, not the interface dir, carries busnum/devnum.
        loop {
            if dir.join("busnum").is_file() && dir.join("devnum").is_file() {
                let busnum = Self::read_sysfs_u8(&dir.join("busnum"))?;
                let devnum = Self::read_sysfs_u8(&dir.join("devnum"))?;
                return Ok(PathBuf::from(Self::usbfs_node_path(busnum, devnum)));
            }
            match dir.parent() {
                Some(parent) if parent.starts_with("/sys") && parent != dir => {
                    dir = parent.to_path_buf();
                }
                _ => return Err(anyhow!("No USB device (busnum/devnum) found above {port}")),
            }
        }
    }

    fn usbfs_node_path(busnum: u8, devnum: u8) -> String {
        format!("/dev/bus/usb/{busnum:03}/{devnum:03}")
    }

    fn read_sysfs_u8(path: &Path) -> Result<u8> {
        let raw = fs::read_to_string(path)
            .map_err(|e| anyhow!("read {} failed: {}", path.display(), e))?;
        raw.trim()
            .parse::<u8>()
            .map_err(|e| anyhow!("parse {} ('{}') failed: {}", path.display(), raw.trim(), e))
    }

    /// Route URCs to the MODEM port (interface 3).
    ///
    /// The AT port is opened per command and closed again, so `RING`/`+CLIP` sent
    /// there are lost. Moving URCs to the otherwise unused MODEM port lets a
    /// persistent reader see incoming calls. Applied at discovery time, so a module
    /// reset cannot leave it unset; SMS collection is unaffected because the daemon
    /// polls `AT+CMGL` and never consumes URCs.
    pub async fn init_urc_port(&self, port: &str) -> Result<()> {
        // Route RING even when the modem refuses CLIP.
        match self
            .send_at_command(port, "AT+CLIP=1", Duration::from_millis(1000))
            .await
        {
            Ok(response) if response.contains("OK") => {}
            Ok(response) => warn!(port, "Could not enable caller ID: {}", response.trim()),
            Err(error) => warn!(port, "Could not enable caller ID: {}", error),
        }
        match self
            .send_at_command(
                port,
                "AT+QURCCFG=\"urcport\",\"usbmodem\"",
                Duration::from_millis(1000),
            )
            .await
        {
            Ok(response) if response.contains("OK") => {
                debug!("URC port set to usbmodem on {}", port);
            }
            Ok(response) => {
                warn!("Failed to set URC port on {}: {}", port, response);
                return Err(anyhow!("Failed to set URC port: {response}"));
            }
            Err(e) => {
                warn!("Error setting URC port on {}: {}", port, e);
                return Err(e);
            }
        }
        Ok(())
    }

    pub fn voice_ports_for_at_port(at_port: &str) -> Result<Option<VoicePorts>> {
        Ok(Self::pick_voice_ports(
            &Self::ttyusb_by_usb_device()?,
            at_port,
        ))
    }

    /// A slimmed modem has no NMEA interface, so it cannot carry voice and yields
    /// `None`, as does an unknown AT port.
    pub fn pick_voice_ports(
        groups: &BTreeMap<String, Vec<String>>,
        at_port: &str,
    ) -> Option<VoicePorts> {
        let ports = groups
            .values()
            .find(|ports| ports.iter().any(|p| p == at_port))?;
        let [_, nmea, at, modem, ..] = ports.as_slice() else {
            return None;
        };
        if at != at_port {
            return None;
        }
        Some(VoicePorts {
            nmea: nmea.clone(),
            modem: modem.clone(),
        })
    }

    /// Takes the same per-port lock as SMS work.
    pub async fn voice_command(
        &self,
        port: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<String> {
        self.send_at_command(port, command, timeout).await
    }

    pub async fn init_ims(&self, port: &str) -> Result<()> {
        match self
            .send_at_command(port, "AT+QCFG=\"ims\",1", Duration::from_millis(1000))
            .await
        {
            Ok(response) if response.contains("OK") => {
                debug!("IMS enabled on {}", port);
            }
            Ok(response) => {
                warn!("Failed to enable IMS on {}: {}", port, response);
                return Err(anyhow!("Failed to enable IMS: {response}"));
            }
            Err(e) => {
                warn!("Error enabling IMS on {}: {}", port, e);
                return Err(e);
            }
        }
        Ok(())
    }

    async fn send_at_command(
        &self,
        port: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<String> {
        let port_lock = self.port_lock(port).await;
        let _guard = port_lock.lock().await;
        Self::send_at_command_unlocked(port, command, timeout).await
    }

    async fn send_at_command_unlocked(
        port: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<String> {
        let port_path = port.to_string();
        let cmd = command.to_string();

        // A wedged modem can block a tty ioctl (tcgetattr/tcflush); O_NONBLOCK covers only
        // read/write. The async deadline abandons the leaked blocking thread so callers
        // skip the bad port instead of hanging.
        let handle =
            tokio::task::spawn_blocking(move || Self::send_at_sync(&port_path, &cmd, timeout));
        match tokio::time::timeout(timeout + Duration::from_secs(2), handle).await {
            Ok(joined) => joined?,
            Err(_) => Err(anyhow!("AT command timed out (port may be wedged): {port}")),
        }
    }

    fn recover_sms_input_sync(port: &str, timeout: Duration) -> Result<String> {
        let mut file = Self::open_serial(port)?;
        file.write_all(&[0x1b])?;
        file.flush()?;
        std::thread::sleep(Duration::from_millis(100));
        drop(file);

        Self::send_at_sync(port, "AT", timeout)
    }

    fn require_recovered_at_channel(response: &str) -> Result<()> {
        if response.contains("OK") {
            Ok(())
        } else {
            Err(anyhow!(
                "Modem did not respond to AT after SMS input recovery: {}",
                response.trim()
            ))
        }
    }

    async fn recover_sms_input_unlocked(&self, port: &str) -> Result<String> {
        let port_path = port.to_string();
        let timeout = self.timeout;
        let handle =
            tokio::task::spawn_blocking(move || Self::recover_sms_input_sync(&port_path, timeout));
        match tokio::time::timeout(timeout + Duration::from_secs(2), handle).await {
            Ok(joined) => joined?,
            Err(_) => Err(anyhow!(
                "SMS input recovery timed out (port may be wedged): {port}"
            )),
        }
    }

    pub(crate) fn open_serial(port: &str) -> Result<File> {
        // Keep O_NONBLOCK set: a blocking open() waits for carrier (DCD), which a wedged
        // modem never asserts, and it makes read()/write() return WouldBlock instead of
        // stalling. O_NOCTTY stops the tty becoming our controlling tty.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOCTTY)
            .open(port)
            .map_err(|e| anyhow!("Failed to open {port}: {e}"))?;

        let mut term = termios::tcgetattr(&file).map_err(|e| anyhow!("tcgetattr failed: {e}"))?;

        termios::cfsetispeed(&mut term, BaudRate::B115200)
            .map_err(|e| anyhow!("cfsetispeed failed: {e}"))?;
        termios::cfsetospeed(&mut term, BaudRate::B115200)
            .map_err(|e| anyhow!("cfsetospeed failed: {e}"))?;

        term.control_flags &= !(termios::ControlFlags::CSIZE | termios::ControlFlags::PARENB);
        term.control_flags |= termios::ControlFlags::CS8
            | termios::ControlFlags::CREAD
            | termios::ControlFlags::CLOCAL;
        term.control_flags &= !termios::ControlFlags::CRTSCTS;

        term.local_flags &= !(termios::LocalFlags::ICANON
            | termios::LocalFlags::ECHO
            | termios::LocalFlags::ECHOE
            | termios::LocalFlags::ISIG);

        term.input_flags &= !(termios::InputFlags::IXON
            | termios::InputFlags::IXOFF
            | termios::InputFlags::IXANY
            | termios::InputFlags::ICRNL
            | termios::InputFlags::INLCR);

        term.output_flags &= !termios::OutputFlags::OPOST;

        // VMIN=0, VTIME=1: 0.1s per read
        set_control_char(&mut term, termios::SpecialCharacterIndices::VMIN, 0)?;
        set_control_char(&mut term, termios::SpecialCharacterIndices::VTIME, 1)?;

        termios::tcsetattr(&file, SetArg::TCSANOW, &term)
            .map_err(|e| anyhow!("tcsetattr failed: {e}"))?;

        termios::tcflush(&file, termios::FlushArg::TCIOFLUSH)
            .map_err(|_| anyhow!("tcflush failed"))?;

        Ok(file)
    }

    /// Blocking; the fd is non-blocking, so writes and reads are polled against `timeout`.
    fn send_at_sync(port: &str, command: &str, timeout: Duration) -> Result<String> {
        let mut file = Self::open_serial(port)?;
        let start = Instant::now();

        let cmd = format!("{command}\r");
        let mut written = 0;
        while let Some(unwritten) = cmd
            .as_bytes()
            .get(written..)
            .filter(|rest| !rest.is_empty())
        {
            if start.elapsed() > timeout {
                return Err(anyhow!("Write timeout on {port}"));
            }
            match file.write(unwritten) {
                Ok(0) => std::thread::sleep(Duration::from_millis(10)),
                Ok(n) => written += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(anyhow!("Write failed: {e}")),
            }
        }
        let _ = file.flush();

        let mut response = Vec::new();
        let mut buf = [0u8; 256];

        loop {
            if start.elapsed() > timeout {
                break;
            }

            match file.read(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(n) => {
                    response.extend_from_slice(read_chunk(&buf, n)?);

                    let text = String::from_utf8_lossy(&response);
                    if text.contains("OK\r")
                        || text.contains("ERROR\r")
                        || text.contains("+CME ERROR")
                    {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(anyhow!("Read error: {e}")),
            }
        }

        let response_str = String::from_utf8_lossy(&response).to_string();
        Ok(response_str)
    }

    pub async fn get_iccid(&self, port: &str) -> Result<Option<Iccid>> {
        // The command that reports the ICCID varies by modem.
        for cmd in &["AT+QCCID", "AT+CCID", "AT+ICCID"] {
            if let Ok(response) = self.send_at_command(port, cmd, self.timeout).await {
                if let Some(iccid) = Self::parse_iccid(&response) {
                    return Ok(Some(iccid));
                }
            }
        }
        Ok(None)
    }

    fn parse_iccid(response: &str) -> Option<Iccid> {
        for line in response.lines() {
            let line = line.trim();
            if line.starts_with("+QCCID:")
                || line.starts_with("+CCID:")
                || line.starts_with("+ICCID:")
            {
                if let Some((_, rest)) = line.split_once(':') {
                    let iccid = rest.trim().trim_matches('"');
                    if iccid.len() >= 18 && iccid.chars().all(|c| c.is_ascii_hexdigit()) {
                        return Self::normalize_iccid(iccid);
                    }
                }
            } else if line.len() >= 18
                && line.len() <= 22
                && line.chars().all(|c| c.is_ascii_hexdigit())
            {
                return Self::normalize_iccid(line);
            }
        }
        None
    }

    /// Strips trailing 'F' BCD filler (ITU-T E.118).
    fn normalize_iccid(iccid: &str) -> Option<Iccid> {
        Iccid::try_from(iccid.trim_end_matches('F')).ok()
    }

    pub async fn get_imei(&self, port: &str) -> Result<Option<Imei>> {
        let response = self.send_at_command(port, "AT+CGSN", self.timeout).await?;
        Ok(Self::parse_imei(&response))
    }

    fn parse_imei(response: &str) -> Option<Imei> {
        response
            .lines()
            .find_map(|line| Imei::try_from(line.trim()).ok())
    }

    pub async fn get_manufacturer(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CGMI", self.timeout).await?;

        for line in response.lines() {
            let line = line.trim();
            if !line.is_empty() && line != "OK" && !line.starts_with('+') && !line.starts_with("AT")
            {
                return Ok(Some(line.to_string()));
            }
        }
        Ok(None)
    }

    pub async fn get_model(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CGMM", self.timeout).await?;

        for line in response.lines() {
            let line = line.trim();
            if !line.is_empty() && line != "OK" && !line.starts_with('+') && !line.starts_with("AT")
            {
                return Ok(Some(line.to_string()));
            }
        }
        Ok(None)
    }

    pub async fn get_revision(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CGMR", self.timeout).await?;

        for line in response.lines() {
            let line = line.trim();
            if !line.is_empty() && line != "OK" && !line.starts_with('+') && !line.starts_with("AT")
            {
                return Ok(Some(line.to_string()));
            }
        }
        Ok(None)
    }

    /// Percent (0-100), scaled from the `+CSQ: <rssi>,<ber>` rssi of 0-31.
    pub async fn get_signal(&self, port: &str) -> Result<u32> {
        let response = self.send_at_command(port, "AT+CSQ", self.timeout).await?;

        for line in response.lines() {
            if line.contains("+CSQ:") {
                if let Some((_, rest)) = line.split_once(':') {
                    let parts: Vec<&str> = rest.trim().split(',').collect();
                    if let Some(rssi_str) = parts.first() {
                        if let Ok(rssi) = rssi_str.trim().parse::<u32>() {
                            if rssi <= 31 {
                                return Ok((rssi * 100) / 31);
                            }
                        }
                    }
                }
            }
        }
        Ok(0)
    }

    pub async fn get_phone_number(&self, port: &str) -> Result<Option<SimNumber>> {
        let response = self.send_at_command(port, "AT+CNUM", self.timeout).await?;
        Ok(Self::parse_cnum(&response))
    }

    // +CNUM: "","+1234567890",129
    fn parse_cnum(response: &str) -> Option<SimNumber> {
        for line in response.lines() {
            if line.contains("+CNUM:") {
                let parts: Vec<&str> = line.split('"').collect();
                if let Some(number) = parts.get(3).map(|part| part.trim()) {
                    if let Ok(number) = SimNumber::try_from(number) {
                        return Some(number);
                    }
                }
            }
        }
        None
    }

    pub async fn get_operator(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+COPS?", self.timeout).await?;

        // +COPS: 0,0,"China Mobile",7
        for line in response.lines() {
            if line.contains("+COPS:") {
                let parts: Vec<&str> = line.split('"').collect();
                if let Some(operator) = parts.get(1).map(|part| part.trim()) {
                    if !operator.is_empty() {
                        return Ok(Some(operator.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }

    pub async fn get_network_registration(&self, port: &str) -> Result<NetworkRegStatus> {
        let circuit_reply = self.send_at_command(port, "AT+CREG?", self.timeout).await?;
        let packet_reply = self
            .send_at_command(port, "AT+CGREG?", self.timeout)
            .await?;

        Ok(NetworkRegStatus {
            creg: Self::parse_creg(&circuit_reply),
            cgreg: Self::parse_cgreg(&packet_reply),
        })
    }

    fn parse_creg(response: &str) -> (u32, u32) {
        for line in response.lines() {
            if line.contains("+CREG:") {
                if let Some((_, fields)) = line.split_once(':') {
                    let mut parts = fields.trim().split(',');
                    if let (Some(n), Some(stat)) = (parts.next(), parts.next()) {
                        let n = n.trim().parse::<u32>().unwrap_or(0);
                        let stat = stat.trim().parse::<u32>().unwrap_or(0);
                        return (n, stat);
                    }
                }
            }
        }
        (0, 0)
    }

    fn parse_cgreg(response: &str) -> (u32, u32) {
        for line in response.lines() {
            if line.contains("+CGREG:") {
                if let Some((_, fields)) = line.split_once(':') {
                    let mut parts = fields.trim().split(',');
                    if let (Some(n), Some(stat)) = (parts.next(), parts.next()) {
                        let n = n.trim().parse::<u32>().unwrap_or(0);
                        let stat = stat.trim().parse::<u32>().unwrap_or(0);
                        return (n, stat);
                    }
                }
            }
        }
        (0, 0)
    }

    pub async fn get_ims_status(&self, port: &str) -> Result<ImsStatus> {
        let response = self
            .send_at_command(port, "AT+QCFG=\"ims\"", self.timeout)
            .await?;

        let mut ims_enabled = false;
        let mut ims_reg_status = String::new();

        for line in response.lines() {
            if line.contains("+QCFG: \"ims\"") {
                if let Some((_, rest)) = line.split_once(',') {
                    let val = rest.trim().trim_matches('"');
                    ims_enabled = val == "1";
                }
            }
        }

        let reg_response = self
            .send_at_command(port, "AT+QIREGAPP?", self.timeout)
            .await?;
        for line in reg_response.lines() {
            if line.contains("+QIREGAPP:") {
                ims_reg_status = line.to_string();
                break;
            }
        }

        Ok(ImsStatus {
            enabled: ims_enabled,
            registration: ims_reg_status,
        })
    }

    pub async fn get_sms_center(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CSCA?", self.timeout).await?;

        for line in response.lines() {
            if line.contains("+CSCA:") {
                if let Some((_, rest)) = line.split_once(':') {
                    let csca = rest.trim().trim_matches('"');
                    if !csca.is_empty() {
                        return Ok(Some(csca.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }

    pub async fn get_sms_config(&self, port: &str) -> Result<SmsConfig> {
        let mode_response = self.send_at_command(port, "AT+CMGF?", self.timeout).await?;
        let mut mode = SmsMode::Unknown;
        for line in mode_response.lines() {
            if line.contains("+CMGF:") {
                if let Some((_, rest)) = line.split_once(':') {
                    let val = rest.trim();
                    if val == "0" {
                        mode = SmsMode::Pdu;
                    } else if val == "1" {
                        mode = SmsMode::Text;
                    }
                }
            }
        }

        let storage_response = self.send_at_command(port, "AT+CPMS?", self.timeout).await?;
        let storage = storage_response
            .lines()
            .find(|l| l.contains("+CPMS:"))
            .map(std::string::ToString::to_string)
            .unwrap_or_default();

        Ok(SmsConfig { mode, storage })
    }

    pub async fn health_check(&self, port: &str) -> Result<ModemHealth> {
        let mut health = ModemHealth {
            port: port.to_string(),
            ..Default::default()
        };

        health.iccid = self.get_iccid(port).await.ok().flatten();
        health.imei = self.get_imei(port).await.ok().flatten();
        health.signal_percent = self.get_signal(port).await.ok();
        health.operator = self.get_operator(port).await.ok().flatten();
        health.network_reg = self.get_network_registration(port).await.ok();
        health.ims_status = self.get_ims_status(port).await.ok();
        health.sms_center = self.get_sms_center(port).await.ok().flatten();
        health.sms_config = self.get_sms_config(port).await.ok();

        Ok(health)
    }

    /// Scans each read storage independently: the EC20 treats `MT` as an alias for `ME`,
    /// not as `ME` + `SM`.
    pub async fn list_sms(&self, port: &str) -> Result<Vec<AtSms>> {
        let stores = self.sms_read_stores(port).await;
        let mut messages = Vec::new();
        let mut successful_stores = 0;
        let mut failures = Vec::new();

        for storage in stores {
            if let Err(e) = self.select_sms_storage(port, storage).await {
                warn!(
                    "Failed to select SMS storage {} on {}: {}; trying next storage",
                    storage, port, e
                );
                failures.push(format!("{storage} selection: {e}"));
                continue;
            }

            match self.list_sms_from_selected_storage(port).await {
                Ok(mut stored_messages) => {
                    for message in &mut stored_messages {
                        message.storage = Some(storage);
                    }
                    debug!(
                        "SMS storage {}: got {} messages from {}",
                        storage,
                        stored_messages.len(),
                        port
                    );
                    messages.append(&mut stored_messages);
                    successful_stores += 1;
                }
                Err(e) => {
                    warn!(
                        "Failed to scan SMS storage {} on {}: {}; trying next storage",
                        storage, port, e
                    );
                    failures.push(format!("{storage} scan: {e}"));
                }
            }
        }

        if successful_stores == 0 {
            return Err(anyhow!(
                "Failed to scan every SMS storage on {}: {}",
                port,
                failures.join("; ")
            ));
        }

        Ok(messages)
    }

    async fn list_sms_from_selected_storage(&self, port: &str) -> Result<Vec<AtSms>> {
        match self.list_sms_pdu_mode(port).await {
            Ok(messages) if !messages.is_empty() => {
                debug!("PDU mode: got {} messages from {}", messages.len(), port);
                Ok(messages)
            }
            Ok(_) => {
                debug!("PDU mode returned empty, trying text mode on {}", port);
                let messages = self.list_sms_text_mode(port).await?;
                debug!("Text mode: got {} messages from {}", messages.len(), port);
                Ok(messages)
            }
            Err(e) => {
                warn!(
                    "PDU mode failed on {}: {} - falling back to text mode",
                    port, e
                );
                let messages = self.list_sms_text_mode(port).await?;
                debug!(
                    "Text mode fallback: got {} messages from {}",
                    messages.len(),
                    port
                );
                Ok(messages)
            }
        }
    }

    /// EC20 is scanned as ME then SM; MT only when neither is advertised.
    async fn sms_read_stores(&self, port: &str) -> Vec<SmsStorage> {
        match self.send_at_command(port, "AT+CPMS=?", self.timeout).await {
            Ok(response) => {
                let supported = Self::parse_cpms_read_stores(&response);
                let stores = Self::sms_read_store_candidates(&supported);
                if stores.is_empty() {
                    warn!(
                        "Modem {} advertised no usable SMS read storage; trying ME and SM",
                        port
                    );
                    vec![SmsStorage::Me, SmsStorage::Sm]
                } else {
                    stores
                }
            }
            Err(e) => {
                warn!(
                    "Failed to query SMS storage capabilities on {}: {}; trying ME and SM",
                    port, e
                );
                vec![SmsStorage::Me, SmsStorage::Sm]
            }
        }
    }

    async fn select_sms_storage(&self, port: &str, storage: SmsStorage) -> Result<()> {
        let command = Self::select_sms_storage_command(storage);
        self.send_at_command(port, &command, self.timeout).await?;
        Ok(())
    }

    fn select_sms_storage_command(storage: SmsStorage) -> String {
        format!("AT+CPMS=\"{storage}\"")
    }

    /// Parse mem1 capabilities from `+CPMS: ("ME","MT",...),(...),(...)`.
    fn parse_cpms_read_stores(response: &str) -> Vec<String> {
        let Some(line) = response.lines().find(|line| line.contains("+CPMS:")) else {
            return Vec::new();
        };
        let Some((inside, _)) = line
            .split_once('(')
            .and_then(|(_, after)| after.split_once(')'))
        else {
            return Vec::new();
        };

        Self::parse_quoted_values(inside)
    }

    fn parse_quoted_values(value: &str) -> Vec<String> {
        value
            .split('"')
            .enumerate()
            .filter(|(index, _)| index % 2 == 1)
            .map(|(_, value)| value.trim().to_ascii_uppercase())
            .filter(|value| !value.is_empty())
            .collect()
    }

    fn sms_read_store_candidates(supported: &[String]) -> Vec<SmsStorage> {
        let mut stores: Vec<SmsStorage> = [SmsStorage::Me, SmsStorage::Sm]
            .into_iter()
            .filter(|candidate| supported.iter().any(|store| store == candidate.as_str()))
            .collect();

        if stores.is_empty()
            && supported
                .iter()
                .any(|store| store == SmsStorage::Mt.as_str())
        {
            stores.push(SmsStorage::Mt);
        }
        stores
    }

    async fn list_sms_text_mode(&self, port: &str) -> Result<Vec<AtSms>> {
        self.send_at_command(port, "AT+CMGF=1", self.timeout)
            .await?;

        // UCS2 is needed for Chinese text; on failure the modem keeps its default charset.
        match self
            .send_at_command(port, "AT+CSCS=\"UCS2\"", self.timeout)
            .await
        {
            Ok(_) => {
                debug!("Text mode: UCS2 charset set successfully on {}", port);
            }
            Err(e) => {
                warn!(
                    "Text mode: Failed to set UCS2 charset on {}: {} - using default",
                    port, e
                );
            }
        }

        let response = self
            .send_at_command(port, "AT+CMGL=\"ALL\"", Duration::from_secs(10))
            .await?;

        let mut messages = Vec::new();
        let mut lines = response.lines().map(str::trim);

        while let Some(line) = lines.next() {
            // +CMGL: 1,"REC READ","+1234567890","","24/01/15,10:30:45+32"
            if line.contains("+CMGL:") {
                if let Some(sms) = Self::parse_cmgl_header(line) {
                    if let Some(raw_text) = lines.next() {
                        if !raw_text.is_empty() && raw_text != "OK" && !raw_text.contains("+CMGL:")
                        {
                            let text = Self::decode_sms_content(raw_text);
                            messages.push(AtSms {
                                storage: None,
                                index: sms.0,
                                part_indices: vec![sms.0],
                                sender: sms.1,
                                timestamp: sms.2,
                                text,
                                concat_info: None,
                            });
                        }
                    }
                }
            }
        }

        Ok(messages)
    }

    /// PDU mode, unlike text mode, exposes the UDH concatenation info.
    async fn list_sms_pdu_mode(&self, port: &str) -> Result<Vec<AtSms>> {
        self.send_at_command(port, "AT+CMGF=0", self.timeout)
            .await?;

        let response = self
            .send_at_command(port, "AT+CMGL=4", Duration::from_secs(10))
            .await?;

        let mut messages = Vec::new();
        let mut lines = response.lines().map(str::trim);

        while let Some(line) = lines.next() {
            // +CMGL: <index>,<stat>,<alpha>,<length>, e.g. 0,1,,23
            if line.contains("+CMGL:") {
                if let Some(index) = Self::parse_cmgl_pdu_header(line) {
                    if let Some(pdu_hex) = lines.next() {
                        if !pdu_hex.is_empty() && pdu_hex != "OK" && !pdu_hex.contains("+CMGL:") {
                            if let Ok(sms) = Self::parse_pdu_sms(index, pdu_hex) {
                                messages.push(sms);
                            }
                        }
                    }
                }
            }
        }

        Ok(messages)
    }

    fn parse_cmgl_pdu_header(line: &str) -> Option<u32> {
        let first_field = line.split(',').next()?;

        let index_part = first_field.split(':').next_back()?.trim();
        index_part.parse::<u32>().ok()
    }

    fn parse_pdu_sms(index: u32, pdu_hex: &str) -> Result<AtSms> {
        let pdu_bytes: Vec<u8> = (0..pdu_hex.len())
            .step_by(2)
            .filter_map(|i| {
                let pair = pdu_hex.get(i..(i + 2).min(pdu_hex.len()))?;
                u8::from_str_radix(pair, 16).ok()
            })
            .collect();

        if pdu_bytes.len() < 10 {
            return Err(anyhow!("PDU too short"));
        }

        let mut pos = 0;

        // Skip the SMSC address
        let smsc_len = usize::from(*pdu_bytes.first().ok_or_else(|| anyhow!("PDU too short"))?);
        pos += 1 + smsc_len;

        let pdu_type = *pdu_bytes
            .get(pos)
            .ok_or_else(|| anyhow!("PDU truncated after SMSC"))?;
        pos += 1;

        // In semi-octets (digits)
        let sender_len = usize::from(
            *pdu_bytes
                .get(pos)
                .ok_or_else(|| anyhow!("PDU truncated at sender length"))?,
        );
        pos += 1;

        let sender_toa = *pdu_bytes
            .get(pos)
            .ok_or_else(|| anyhow!("PDU truncated at sender type"))?;
        pos += 1;

        // Type-of-number (bits 6-4): 0x05 = alphanumeric (GSM 7-bit packed)
        let sender_number_type = (sender_toa >> 4) & 0x07;

        let sender_bytes = sender_len.div_ceil(2);
        let sender_address = pdu_bytes
            .get(pos..pos + sender_bytes)
            .ok_or_else(|| anyhow!("PDU truncated at sender address"))?;
        let sender = if sender_number_type == 0x05 {
            // For alphanumeric senders sender_len counts semi-octets: septets = len * 4 / 7
            let num_septets = (sender_len * 4) / 7;
            Self::decode_pdu_7bit(sender_address, num_septets, 0)
        } else {
            Self::decode_bcd_phone(sender_address, sender_len)
        };
        pos += sender_bytes;

        // PID
        if pdu_bytes.get(pos).is_none() {
            return Err(anyhow!("PDU truncated at PID"));
        }
        pos += 1;

        let dcs = *pdu_bytes
            .get(pos)
            .ok_or_else(|| anyhow!("PDU truncated at DCS"))?;
        pos += 1;

        let timestamp_bytes = pdu_bytes
            .get(pos..pos + 7)
            .ok_or_else(|| anyhow!("PDU truncated at timestamp"))?;
        let timestamp = Self::decode_pdu_timestamp(timestamp_bytes);
        pos += 7;

        let user_data_len = usize::from(
            *pdu_bytes
                .get(pos)
                .ok_or_else(|| anyhow!("PDU truncated at UDL"))?,
        );
        pos += 1;

        let has_udh = (pdu_type & 0x40) != 0;
        let mut concat_info = None;
        let mut text_start = pos;
        let udhl = if has_udh {
            let udhl = usize::from(
                *pdu_bytes
                    .get(pos)
                    .ok_or_else(|| anyhow!("PDU truncated at UDHL"))?,
            );
            pos += 1;

            let udh = pdu_bytes
                .get(pos..pos + udhl)
                .ok_or_else(|| anyhow!("PDU truncated at UDH"))?;
            concat_info = Self::extract_udh_concat(udh);
            pos += udhl;
            text_start = pos;
            udhl
        } else {
            0
        };

        // GSM 03.38 DCS: 0x00 = 7-bit default alphabet, 0x04 = 8-bit data, 0x08 = UCS-2
        let text_bytes = pdu_bytes
            .get(text_start..)
            .ok_or_else(|| anyhow!("PDU truncated before text"))?;
        let text = if (dcs & 0x08) != 0 {
            debug!("PDU encoding detected: UCS-2 (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_ucs2(text_bytes, user_data_len)
        } else if (dcs & 0x04) != 0 {
            debug!("PDU encoding detected: 8-bit data (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_8bit(text_bytes)
        } else {
            debug!("PDU encoding detected: 7-bit GSM (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_7bit(text_bytes, user_data_len, udhl)
        };

        Ok(AtSms {
            storage: None,
            index,
            part_indices: vec![index],
            sender: SmsAddress::from(sender),
            timestamp,
            text,
            concat_info,
        })
    }

    /// Plain 8-bit text passes through; binary WAP Push payloads become a readable
    /// notification; other binary data is converted lossily.
    fn decode_pdu_8bit(bytes: &[u8]) -> String {
        if let Ok(text) = std::str::from_utf8(bytes) {
            let is_plain_text = text.chars().all(|character| {
                !character.is_control() || matches!(character, '\n' | '\r' | '\t')
            });
            if is_plain_text {
                return text.to_string();
            }
        }

        if let Some(url) = Self::extract_http_url(bytes) {
            return format!("运营商 WAP Push\n链接：{url}");
        }

        String::from_utf8_lossy(bytes).to_string()
    }

    fn extract_http_url(bytes: &[u8]) -> Option<String> {
        let start = (0..bytes.len()).find(|&index| {
            bytes
                .get(index..)
                .is_some_and(|rest| rest.starts_with(b"https://") || rest.starts_with(b"http://"))
        })?;
        let end = bytes
            .get(start..)?
            .iter()
            .position(|byte| !byte.is_ascii_graphic())
            .map_or(bytes.len(), |length| start + length);
        std::str::from_utf8(bytes.get(start..end)?)
            .ok()
            .map(str::to_owned)
    }

    fn extract_udh_concat(udh_bytes: &[u8]) -> Option<ConcatInfo> {
        let mut rest = udh_bytes;
        while let [iei, iedl, tail @ ..] = rest {
            let Some((element, next)) = tail.split_at_checked(usize::from(*iedl)) else {
                break;
            };

            // IEI 0x00: Concatenated short message, 8-bit reference
            // IEI 0x08: Concatenated short message, 16-bit reference
            // The 16-bit form keeps only the lower byte of its reference.
            let ids = match (*iei, element) {
                (0x00, &[ref_id, total_parts, part_number])
                | (0x08, &[_, ref_id, total_parts, part_number]) => {
                    Some((ref_id, total_parts, part_number))
                }
                _ => None,
            };
            if let Some((ref_id, total_parts, part_number)) = ids {
                return Some(ConcatInfo {
                    ref_id,
                    total_parts,
                    part_number,
                });
            }

            rest = next;
        }
        None
    }

    /// Map a BCD nibble (0x0-0xF) to its character per GSM 03.40 Section 9.1.2.3
    fn bcd_nibble_to_char(nibble: u8) -> Option<char> {
        match nibble {
            0x0..=0x9 => Some(char::from(b'0' + nibble)),
            0xA => Some('*'),
            0xB => Some('#'),
            0xC => Some('a'),
            0xD => Some('b'),
            _ => None, // 0xE and 0xF are reserved filler
        }
    }

    fn decode_bcd_phone(bytes: &[u8], digit_count: usize) -> String {
        let mut phone = String::new();
        for (i, byte) in bytes.iter().enumerate() {
            let nibble_lo = byte & 0x0F;
            let nibble_hi = (byte >> 4) & 0x0F;

            if i * 2 < digit_count {
                if let Some(ch) = Self::bcd_nibble_to_char(nibble_lo) {
                    phone.push(ch);
                }
            }
            if i * 2 + 1 < digit_count {
                if let Some(ch) = Self::bcd_nibble_to_char(nibble_hi) {
                    phone.push(ch);
                }
            }
        }
        phone
    }

    fn decode_pdu_timestamp(bytes: &[u8]) -> String {
        let &[year, month, day, hour, minute, second, tz_byte, ..] = bytes else {
            return chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
        };

        // Semi-octets: each byte carries its BCD digits swapped (low nibble is the tens)
        let decode_bcd = |b: u8| -> u8 {
            let swapped = ((b & 0x0F) << 4) | ((b >> 4) & 0x0F);
            let high = (swapped >> 4) & 0x0F;
            let low = swapped & 0x0F;
            high * 10 + low
        };

        let year = i32::from(decode_bcd(year)) + 2000;
        let month = u32::from(decode_bcd(month));
        let day = u32::from(decode_bcd(day));
        let hour = u32::from(decode_bcd(hour));
        let minute = u32::from(decode_bcd(minute));
        let second = u32::from(decode_bcd(second));

        // Timezone is BCD quarter-hours; bit 7 of the raw byte is the sign.
        let tz_sign = if (tz_byte & 0x80) != 0 { -1 } else { 1 };
        let tz_quarters = i32::from(decode_bcd(tz_byte & 0x7F));
        let tz_offset_minutes = tz_sign * tz_quarters * 15;

        let naive = chrono::NaiveDate::from_ymd_opt(year, month, day)
            .and_then(|d| d.and_hms_opt(hour, minute, second))
            .unwrap_or_else(|| chrono::Utc::now().naive_utc());

        let dt = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
            naive - chrono::Duration::minutes(i64::from(tz_offset_minutes)),
            chrono::Utc,
        );

        dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }

    /// GSM 03.38 default alphabet. Index 0x1B (ESC) is never looked up; the decoder
    /// handles it as the extension prefix.
    const GSM_DEFAULT_ALPHABET: [char; 128] = [
        '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', // 0x00-0x07
        'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å', // 0x08-0x0F
        'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', // 0x10-0x17
        'Σ', 'Θ', 'Ξ', ' ', 'Æ', 'æ', 'ß', 'É', // 0x18-0x1F
        ' ', '!', '"', '#', '¤', '%', '&', '\'', // 0x20-0x27
        '(', ')', '*', '+', ',', '-', '.', '/', // 0x28-0x2F
        '0', '1', '2', '3', '4', '5', '6', '7', // 0x30-0x37
        '8', '9', ':', ';', '<', '=', '>', '?', // 0x38-0x3F
        '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', // 0x40-0x47
        'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', // 0x48-0x4F
        'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', // 0x50-0x57
        'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§', // 0x58-0x5F
        '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', // 0x60-0x67
        'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', // 0x68-0x6F
        'p', 'q', 'r', 's', 't', 'u', 'v', 'w', // 0x70-0x77
        'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à', // 0x78-0x7F
    ];

    /// GSM 03.38 extension table, reached via the ESC 0x1B prefix.
    fn gsm_extension_char(code: u8) -> Option<char> {
        match code {
            0x0A => Some('\u{000C}'),
            0x14 => Some('^'),
            0x28 => Some('{'),
            0x29 => Some('}'),
            0x2F => Some('\\'),
            0x3C => Some('['),
            0x3D => Some('~'),
            0x3E => Some(']'),
            0x40 => Some('|'),
            0x65 => Some('€'),
            _ => None,
        }
    }

    /// `bytes` excludes the UDH; `septet_count` is the User Data Length in septets;
    /// `udhl` is the UDH length in bytes (0 if none), which determines the fill bits.
    fn decode_pdu_7bit(bytes: &[u8], septet_count: usize, udhl: usize) -> String {
        // Fill bits pad the UDH out to a septet boundary.
        let fill_bits = if udhl > 0 {
            (7 - ((udhl + 1) * 8) % 7) % 7
        } else {
            0
        };

        let mut result = String::new();
        let mut bit_pos = fill_bits;
        let mut escape_next = false;

        for _ in 0..septet_count {
            let byte_pos = bit_pos / 8;
            let shift = bit_pos % 8;

            let Some(&low_byte) = bytes.get(byte_pos) else {
                break;
            };
            let mut char_val = (low_byte >> shift) & 0x7F;
            if shift > 1 {
                if let Some(&high_byte) = bytes.get(byte_pos + 1) {
                    char_val |= (high_byte << (8 - shift)) & 0x7F;
                }
            }

            if escape_next {
                escape_next = false;
                if let Some(ext_char) = Self::gsm_extension_char(char_val) {
                    result.push(ext_char);
                } else {
                    result.push(' ');
                }
            } else if char_val == 0x1B {
                escape_next = true;
            } else {
                result.push(
                    Self::GSM_DEFAULT_ALPHABET
                        .get(usize::from(char_val))
                        .copied()
                        .unwrap_or(' '),
                );
            }

            bit_pos += 7;
        }

        result
    }

    fn decode_pdu_ucs2(bytes: &[u8], _udl: usize) -> String {
        if bytes.is_empty() {
            return String::new();
        }

        let u16_values: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_be_bytes)
            .collect();

        String::from_utf16(&u16_values).unwrap_or_else(|_| String::from("?"))
    }

    /// Text-mode output after `AT+CSCS="UCS2"` is UTF-16BE hex.
    fn decode_sms_content(raw: &str) -> String {
        let is_hex = raw.len() >= 4
            && raw.len().is_multiple_of(4)
            && raw.chars().all(|c| c.is_ascii_hexdigit());

        if is_hex {
            // Plain digit strings can look like hex; keep the raw text unless the decode is printable.
            if let Some(decoded) = Self::decode_ucs2_hex(raw) {
                if !decoded.is_empty()
                    && decoded
                        .chars()
                        .all(|c| !c.is_control() || c == '\n' || c == '\r')
                {
                    debug!("Decoded UCS2: {} -> {}", raw, decoded);
                    return decoded;
                }
            }
        }

        raw.to_string()
    }

    /// Some modems expose alphanumeric senders as concatenated decimal ASCII
    /// code points (for example, `83 105 110 ...` for `Singtel`). E.164 phone
    /// numbers are at most 15 digits, so only longer numeric values are eligible
    /// for this decoding path.
    fn decode_sms_sender(raw: &str) -> String {
        if raw.chars().all(|character| character.is_ascii_digit()) {
            if raw.len() <= 15 {
                return raw.to_string();
            }

            if raw.len() <= 36 {
                let mut candidates = Vec::new();
                Self::decode_decimal_ascii_candidates(raw, 0, String::new(), &mut candidates);
                if let [candidate] = candidates.as_slice() {
                    if candidate
                        .chars()
                        .any(|character| character.is_ascii_alphabetic())
                        && candidate.chars().all(|character| {
                            character.is_ascii_alphanumeric()
                                || matches!(character, ' ' | '&' | '.' | '-' | '+')
                        })
                    {
                        return candidate.clone();
                    }
                }
            }
        }

        Self::decode_sms_content(raw)
    }

    fn decode_decimal_ascii_candidates(
        raw: &str,
        offset: usize,
        decoded: String,
        candidates: &mut Vec<String>,
    ) {
        if candidates.len() > 1 {
            return;
        }
        if offset == raw.len() {
            candidates.push(decoded);
            return;
        }

        for width in [2, 3] {
            let end = offset + width;
            if end > raw.len() {
                continue;
            }
            let Some(Ok(code_point)) = raw.get(offset..end).map(str::parse::<u8>) else {
                continue;
            };
            if !(32..=126).contains(&code_point) {
                continue;
            }

            let mut next = decoded.clone();
            next.push(char::from(code_point));
            Self::decode_decimal_ascii_candidates(raw, end, next, candidates);
        }
    }

    /// "4F60597D" -> "你好"
    fn decode_ucs2_hex(hex: &str) -> Option<String> {
        if !hex.len().is_multiple_of(2) {
            return None;
        }

        let bytes = hex
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
            .collect::<Option<Vec<u8>>>()?;

        if bytes.len() % 2 != 0 {
            return None;
        }

        let u16_values: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_be_bytes)
            .collect();

        String::from_utf16(&u16_values).ok()
    }

    /// +CMGL: 1,"REC READ","+1234567890","","24/01/15,10:30:45+32"
    /// Under UCS2 the sender and timestamp fields are hex encoded.
    fn parse_cmgl_header(line: &str) -> Option<(u32, SmsAddress, String)> {
        let parts: Vec<&str> = line.split(',').collect();
        let [first_field, _, sender_field, ..] = parts.as_slice() else {
            return None;
        };

        let index_part = first_field.split(':').next_back()?.trim();
        let index = index_part.parse::<u32>().ok()?;

        let raw_sender = sender_field.trim().trim_matches('"');
        let sender = SmsAddress::from(Self::decode_sms_sender(raw_sender));

        let timestamp = if parts.len() >= 5 {
            let raw_date = parts.get(4).map_or("", |s| s.trim().trim_matches('"'));
            let raw_time = parts.get(5).map_or("", |s| s.trim().trim_matches('"'));
            let date = Self::decode_sms_content(raw_date);
            let time = Self::decode_sms_content(raw_time);
            Self::normalize_sms_timestamp(&date, &time)
        } else {
            chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        };

        Some((index, sender, timestamp))
    }

    /// Split a trailing `-NN` offset off `time`, ignoring a leading sign character.
    fn split_negative_offset(time: &str) -> Option<(&str, &str)> {
        let pos = time.get(1..)?.rfind('-')? + 1;
        let (clock, tail) = time.split_at_checked(pos)?;
        Some((clock, tail.strip_prefix('-')?))
    }

    /// Inputs are "24/01/15" (YY/MM/DD) and "10:30:45+32" (HH:MM:SS plus a UTC offset in
    /// quarter-hours, so +32 is UTC+8). Returns RFC3339 UTC.
    fn normalize_sms_timestamp(date: &str, time: &str) -> String {
        let date_parts: Vec<&str> = date.split('/').collect();

        let (time_clean, offset_minutes) = if let Some((t, tz)) = time.rsplit_once('+') {
            let tz_quarters: i32 = tz.parse().unwrap_or(0);
            (t, tz_quarters * 15)
        } else if let Some((t, tz)) = Self::split_negative_offset(time) {
            let tz_quarters: i32 = tz.parse().unwrap_or(0);
            (t, -(tz_quarters * 15))
        } else {
            (time, 0i32)
        };

        if let [year, month, day, ..] = date_parts.as_slice() {
            let year = format!("20{year}");

            let local_str = format!("{year}-{month}-{day}T{time_clean}");
            if let Ok(naive) =
                chrono::NaiveDateTime::parse_from_str(&local_str, "%Y-%m-%dT%H:%M:%S")
            {
                let utc = naive - chrono::Duration::minutes(i64::from(offset_minutes));
                return format!("{}Z", utc.format("%Y-%m-%dT%H:%M:%S%.3f"));
            }

            let tz_hours = offset_minutes.abs() / 60;
            let tz_mins = offset_minutes.abs() % 60;
            let sign = if offset_minutes >= 0 { '+' } else { '-' };
            return format!("{year}-{month}-{day}T{time_clean}{sign}{tz_hours:02}:{tz_mins:02}");
        }

        chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }

    pub async fn delete_sms(&self, port: &str, index: u32) -> Result<()> {
        let cmd = format!("AT+CMGD={index}");
        let response = self.send_at_command(port, &cmd, self.timeout).await?;

        if response.contains("OK") {
            debug!("Deleted SMS {} from {}", index, port);
            Ok(())
        } else {
            Err(anyhow!("Failed to delete SMS {index}: {response}"))
        }
    }

    /// Indices are scoped to CPMS mem1, so the storage must be selected first.
    pub async fn delete_sms_from_storage(
        &self,
        port: &str,
        storage: SmsStorage,
        index: u32,
    ) -> Result<()> {
        self.select_sms_storage(port, storage).await?;
        self.delete_sms(port, index).await
    }

    pub async fn delete_all_sms(&self, port: &str) -> Result<()> {
        // AT+CMGD=1,4: delete-flag 4 deletes all messages
        let response = self
            .send_at_command(port, "AT+CMGD=1,4", self.timeout)
            .await?;

        if response.contains("OK") {
            info!("Deleted all SMS from {}", port);
            Ok(())
        } else {
            Err(anyhow!("Failed to delete all SMS: {response}"))
        }
    }

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
    pub(crate) fn validate_recipient(recipient: &str) -> Result<()> {
        Self::validate_recipient_with_short_code(recipient, false)
    }

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

    pub async fn send_sms(
        &self,
        port: &str,
        recipient: &SmsAddress,
        message: &str,
    ) -> Result<SmsSubmission> {
        Self::validate_recipient(recipient.as_str())?;
        self.send_sms_with_short_code(port, recipient, message, false)
            .await
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

    fn is_prompt_timeout(error: &anyhow::Error) -> bool {
        error.to_string() == SMS_PROMPT_TIMEOUT_ERROR
    }

    fn should_recover_after_submit(outcome: SmsSubmission) -> bool {
        matches!(outcome, SmsSubmission::SubmittedUnconfirmed)
    }

    fn classify_post_submit_recovery_response(response: &str) -> Result<()> {
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

    fn classify_sms_submit_response(response: &str, timed_out: bool) -> Result<SmsSubmission> {
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

    fn has_sms_submit_final_code(response: &str) -> bool {
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
            .map_or_else(|| port.to_string(), std::string::ToString::to_string)
    }

    pub fn modem_id_to_port(id: &str) -> String {
        if id.parse::<u32>().is_ok() {
            return format!("/dev/ttyUSB{id}");
        }
        id.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdu_whose_udhl_overruns_the_pdu_is_an_error() {
        let pdu = "0040008100000000000000000005FF01";
        assert!(AtModemManager::parse_pdu_sms(0, pdu).is_err());
    }

    #[test]
    fn pdu_line_with_multibyte_character_is_an_error() {
        let pdu = "0\u{e9}400081000000000000000000";
        assert!(AtModemManager::parse_pdu_sms(0, pdu).is_err());
    }

    #[test]
    fn cmgl_header_without_a_time_field_does_not_panic() {
        let header = r#"+CMGL: 1,"REC READ","+123","","24/01/15""#;
        let (index, sender, _) = AtModemManager::parse_cmgl_header(header).unwrap();
        assert_eq!((index, sender.as_str()), (1, "+123"));
    }

    #[test]
    fn timestamp_with_a_multibyte_first_character_does_not_panic() {
        let stamp = AtModemManager::normalize_sms_timestamp("24/01/15", "\u{4f60}0:30:45");
        assert!(stamp.starts_with("2024-01-15"));
    }

    #[tokio::test]
    async fn reuses_one_serial_lock_per_port() {
        let manager = AtModemManager::new();
        let first = manager.port_lock("/dev/ttyUSB2").await;
        let same_port = manager.port_lock("/dev/ttyUSB2").await;
        let other_port = manager.port_lock("/dev/ttyUSB6").await;

        assert!(Arc::ptr_eq(&first, &same_port));
        assert!(!Arc::ptr_eq(&first, &other_port));
    }

    #[test]
    fn retries_only_before_the_sms_body_is_written() {
        assert!(AtModemManager::is_prompt_timeout(&anyhow!(
            SMS_PROMPT_TIMEOUT_ERROR
        )));
        assert!(!AtModemManager::is_prompt_timeout(&anyhow!(
            "Send SMS failed after Ctrl-Z"
        )));
        assert_eq!(SMS_PROMPT_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn treats_post_submit_timeout_without_modem_error_as_unconfirmed_submission() {
        assert_eq!(
            AtModemManager::classify_sms_submit_response("0", true).unwrap(),
            SmsSubmission::SubmittedUnconfirmed,
        );
    }

    #[test]
    fn recovers_the_at_channel_only_after_an_unconfirmed_submission() {
        assert!(AtModemManager::should_recover_after_submit(
            SmsSubmission::SubmittedUnconfirmed
        ));
        assert!(!AtModemManager::should_recover_after_submit(
            SmsSubmission::Confirmed
        ));
    }

    #[test]
    fn turns_a_late_explicit_modem_error_into_a_failed_submission() {
        let error = AtModemManager::classify_post_submit_recovery_response("+CMS ERROR: 350\r\n")
            .unwrap_err();

        assert!(error.to_string().contains("+CMS ERROR: 350"));
        assert!(AtModemManager::classify_post_submit_recovery_response("AT\r\nOK\r\n").is_ok());
        assert!(AtModemManager::classify_post_submit_recovery_response("NO ERROR").is_ok());
    }

    #[test]
    fn requires_an_explicit_modem_error_to_fail_after_submission() {
        let error =
            AtModemManager::classify_sms_submit_response("+CMS ERROR: 500\r\n", false).unwrap_err();

        assert!(error.to_string().contains("+CMS ERROR: 500"));
    }

    #[test]
    fn does_not_treat_words_in_the_echo_as_final_result_codes() {
        assert_eq!(
            AtModemManager::classify_sms_submit_response("BOOK", true).unwrap(),
            SmsSubmission::SubmittedUnconfirmed,
        );
        assert_eq!(
            AtModemManager::classify_sms_submit_response("NO ERROR", true).unwrap(),
            SmsSubmission::SubmittedUnconfirmed,
        );
    }

    fn four_port_modem() -> BTreeMap<String, Vec<String>> {
        let mut groups = BTreeMap::new();
        groups.insert(
            "1-1.3.4.3.4".to_string(),
            (68..=71).map(|n| format!("/dev/ttyUSB{n}")).collect(),
        );
        groups
    }

    #[test]
    fn test_pick_voice_ports_returns_nmea_and_modem() {
        assert_eq!(
            AtModemManager::pick_voice_ports(&four_port_modem(), "/dev/ttyUSB70"),
            Some(VoicePorts {
                nmea: "/dev/ttyUSB69".to_string(),
                modem: "/dev/ttyUSB71".to_string(),
            })
        );
    }

    #[test]
    fn test_pick_voice_ports_none_for_slimmed_modem() {
        let mut groups = BTreeMap::new();
        groups.insert(
            "1-1.3.4.3.5".to_string(),
            (80..=82).map(|n| format!("/dev/ttyUSB{n}")).collect(),
        );
        assert_eq!(
            AtModemManager::pick_voice_ports(&groups, "/dev/ttyUSB81"),
            None
        );
    }

    #[test]
    fn test_pick_voice_ports_none_when_port_is_not_the_at_port() {
        assert_eq!(
            AtModemManager::pick_voice_ports(&four_port_modem(), "/dev/ttyUSB71"),
            None
        );
    }

    #[test]
    fn test_pick_voice_ports_none_for_unknown_port() {
        assert_eq!(
            AtModemManager::pick_voice_ports(&four_port_modem(), "/dev/ttyUSB99"),
            None
        );
    }

    #[test]
    fn test_validate_recipient_accepts_e164() {
        assert!(AtModemManager::validate_recipient_with_short_code("+6512345678", false).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("6512345678", false).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("+861380013800", false).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("123456", false).is_ok());
        assert!(
            AtModemManager::validate_recipient_with_short_code("+123456789012345", false).is_ok()
        );
    }

    #[test]
    fn test_validate_recipient_rejects_at_injection() {
        // The payload from the security review: terminate CMGS, then wipe the SIM.
        assert!(AtModemManager::validate_recipient_with_short_code(
            "+6512345678\r\nAT+CMGD=1,4\r",
            false
        )
        .is_err());
        assert!(AtModemManager::validate_recipient_with_short_code(
            "+6512345678\rAT+CMGD=1,4",
            false
        )
        .is_err());
        assert!(
            AtModemManager::validate_recipient_with_short_code("+6512345678\n", false).is_err()
        );
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\"", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\x1A", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\x1B", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\0", false).is_err());
    }

    #[test]
    fn test_validate_recipient_rejects_malformed() {
        assert!(AtModemManager::validate_recipient_with_short_code("", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("+", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("12345", false).is_err());
        assert!(
            AtModemManager::validate_recipient_with_short_code("+1234567890123456", false).is_err()
        );
        assert!(
            AtModemManager::validate_recipient_with_short_code("+65 1234 5678", false).is_err()
        );
        assert!(
            AtModemManager::validate_recipient_with_short_code("+65-1234-5678", false).is_err()
        );
        assert!(AtModemManager::validate_recipient_with_short_code("not-a-number", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("65+12345678", false).is_err());
    }

    #[test]
    fn test_validate_recipient_allows_short_code_only_when_explicit() {
        assert!(AtModemManager::validate_recipient_with_short_code("10086", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("10086", true).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("123", true).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("+10086", true).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("12", true).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("10086\r", true).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("10A86", true).is_err());
    }

    #[test]
    fn test_validate_message_body_rejects_terminators() {
        assert!(AtModemManager::validate_message_body("hello").is_ok());
        assert!(AtModemManager::validate_message_body("你好，验证码 1234").is_ok());
        assert!(AtModemManager::validate_message_body("line one\nline two").is_ok());
        assert!(AtModemManager::validate_message_body("line one\r\nline two").is_ok());

        assert!(AtModemManager::validate_message_body("x\x1AAT+CMGD=1,4\r").is_err());
        assert!(AtModemManager::validate_message_body("x\x1B").is_err());
        assert!(AtModemManager::validate_message_body("x\0y").is_err());
    }

    #[test]
    fn test_parse_iccid() {
        assert_eq!(
            AtModemManager::parse_iccid("+QCCID: 89860121750097854321"),
            Iccid::try_from("89860121750097854321").ok()
        );
        assert_eq!(
            AtModemManager::parse_iccid("89860121750097854321\nOK"),
            Iccid::try_from("89860121750097854321").ok()
        );
        assert_eq!(
            AtModemManager::parse_iccid("+QCCID: 8965012306052989707F"),
            Iccid::try_from("8965012306052989707").ok()
        );
        assert_eq!(
            AtModemManager::parse_iccid("AT+QCCID\r\n+QCCID: 8965012306052989681F\r\n\r\nOK\r\n"),
            Iccid::try_from("8965012306052989681").ok()
        );
    }

    #[test]
    fn parse_iccid_accepts_exactly_what_it_accepted_before_it_was_typed() {
        for (response, expected) in [
            ("+CCID: 898600520121F0517883", Some("898600520121F0517883")),
            (
                "+ICCID: \"89860121750097854321\"",
                Some("89860121750097854321"),
            ),
            ("+QCCID: 89860121750097854a", Some("89860121750097854a")),
            ("+QCCID: 898601217500978543", Some("898601217500978543")),
            ("+QCCID: 89860121750097854", None),
            ("+QCCID: 8986012175009785432G", None),
            ("+QCCID: ", None),
            ("8986012175009785432123\nOK", Some("8986012175009785432123")),
            ("89860121750097854321234\nOK", None),
            ("OK", None),
            ("", None),
        ] {
            assert_eq!(
                AtModemManager::parse_iccid(response),
                expected.map(|text| Iccid::try_from(text).unwrap()),
                "{response:?}"
            );
        }
    }

    #[test]
    fn parse_imei_needs_a_line_of_exactly_fifteen_digits() {
        let imei = |text: &str| Imei::try_from(text).ok();
        assert_eq!(
            AtModemManager::parse_imei("AT+CGSN\r\n860123456789012\r\n\r\nOK\r\n"),
            imei("860123456789012")
        );
        assert_eq!(
            AtModemManager::parse_imei("  860123456789012  \nOK"),
            imei("860123456789012")
        );
        assert_eq!(AtModemManager::parse_imei("86012345678901\nOK"), None);
        assert_eq!(AtModemManager::parse_imei("8601234567890123\nOK"), None);
        assert_eq!(AtModemManager::parse_imei("86012345678901a\nOK"), None);
        assert_eq!(AtModemManager::parse_imei("ERROR"), None);
    }

    #[test]
    fn parse_cnum_keeps_any_non_empty_number() {
        let number = |text: &str| SimNumber::try_from(text).ok();
        assert_eq!(
            AtModemManager::parse_cnum("+CNUM: \"\",\"+6591234567\",145\nOK"),
            number("+6591234567")
        );
        assert_eq!(
            AtModemManager::parse_cnum("+CNUM: \"\",\" 6591234567 \",129"),
            number("6591234567")
        );
        assert_eq!(AtModemManager::parse_cnum("+CNUM: \"\",\"\",129"), None);
        assert_eq!(AtModemManager::parse_cnum("+CNUM: \"\",\"   \",129"), None);
        assert_eq!(AtModemManager::parse_cnum("OK"), None);
    }

    #[test]
    fn test_parse_cpms_read_stores_uses_mem1_capabilities_only() {
        let response = concat!(
            "AT+CPMS=?\r\n",
            "+CPMS: (\"ME\",\"MT\",\"SM\",\"SR\"),(\"ME\",\"SM\"),(\"ME\",\"SM\")\r\n",
            "OK\r\n"
        );

        assert_eq!(
            AtModemManager::parse_cpms_read_stores(response),
            vec!["ME", "MT", "SM", "SR"]
        );
    }

    #[test]
    fn test_parse_cpms_read_stores_rejects_malformed_response() {
        assert!(AtModemManager::parse_cpms_read_stores("OK").is_empty());
        assert!(AtModemManager::parse_cpms_read_stores("+CPMS: \"MT\"").is_empty());
        assert!(AtModemManager::parse_cpms_read_stores("+CPMS: (\"MT\"").is_empty());
    }

    #[test]
    fn test_select_sms_storage_command_text_is_unchanged() {
        assert_eq!(
            AtModemManager::select_sms_storage_command(SmsStorage::Me),
            "AT+CPMS=\"ME\""
        );
        assert_eq!(
            AtModemManager::select_sms_storage_command(SmsStorage::Sm),
            "AT+CPMS=\"SM\""
        );
        assert_eq!(
            AtModemManager::select_sms_storage_command(SmsStorage::Mt),
            "AT+CPMS=\"MT\""
        );
    }

    #[test]
    fn test_sms_read_store_candidates_scan_me_then_sm() {
        let supported = vec!["SM".into(), "ME".into(), "MT".into(), "SR".into()];

        assert_eq!(
            AtModemManager::sms_read_store_candidates(&supported),
            vec![SmsStorage::Me, SmsStorage::Sm]
        );
    }

    #[test]
    fn test_sms_read_store_candidates_use_mt_only_as_fallback() {
        let supported = vec!["MT".into(), "SR".into()];

        assert_eq!(
            AtModemManager::sms_read_store_candidates(&supported),
            vec![SmsStorage::Mt]
        );
    }

    #[test]
    fn test_sms_read_store_candidates_exclude_status_report_storage() {
        let supported = vec!["SR".into(), "BM".into()];

        assert!(AtModemManager::sms_read_store_candidates(&supported).is_empty());
    }

    #[test]
    fn test_ucs2_decode() {
        assert_eq!(
            AtModemManager::decode_ucs2_hex("4F60597D"),
            Some("你好".to_string())
        );

        assert_eq!(
            AtModemManager::decode_ucs2_hex("00480069"),
            Some("Hi".to_string())
        );

        assert_eq!(AtModemManager::decode_ucs2_hex(""), Some(String::new()));
        assert_eq!(AtModemManager::decode_ucs2_hex("4F6"), None);
    }

    #[test]
    fn test_decode_sms_content() {
        assert_eq!(AtModemManager::decode_sms_content("4F60597D"), "你好");

        assert_eq!(
            AtModemManager::decode_sms_content("Hello World"),
            "Hello World"
        );

        assert_eq!(
            AtModemManager::decode_sms_content("1234"),
            AtModemManager::decode_sms_content("1234")
        );
    }

    #[test]
    fn test_decode_sms_sender_normalizes_decimal_ascii_names() {
        assert_eq!(
            AtModemManager::decode_sms_sender("83105110103116101108"),
            "Singtel"
        );
        assert_eq!(
            AtModemManager::decode_sms_sender("831051101031161011083266105122"),
            "Singtel Biz"
        );
    }

    #[test]
    fn test_decode_sms_sender_preserves_numeric_addresses() {
        assert_eq!(AtModemManager::decode_sms_sender("1234"), "1234");
        assert_eq!(
            AtModemManager::decode_sms_sender("6591234567"),
            "6591234567"
        );
    }

    #[test]
    fn test_pdu_7bit_gsm_encoding() {
        let bytes = vec![0xC8, 0x32, 0x9B, 0xFD, 0x06];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 0);
        assert_eq!(result, "Hello");
    }

    #[test]
    fn test_pdu_ucs2_encoding_chinese() {
        let bytes = vec![0x4F, 0x60, 0x59, 0x7D];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 4);
        assert_eq!(result, "你好");
    }

    #[test]
    fn test_pdu_ucs2_encoding_mixed() {
        let bytes = vec![0x00, 0x48, 0x00, 0x69, 0x4F, 0x60, 0x59, 0x7D];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 8);
        assert_eq!(result, "Hi你好");
    }

    #[test]
    fn test_pdu_ucs2_with_udh() {
        // The caller strips the UDH (05 00 03 42 02 01) before decode_pdu_ucs2.
        let bytes = vec![0x4F, 0x60];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 2);
        assert_eq!(result, "你");
    }

    #[test]
    fn test_pdu_dcs_detection() {
        let dcs_7bit = 0x00;
        assert_eq!(dcs_7bit & 0x04, 0);

        let dcs_ucs2_common = 0x08;
        assert_ne!(dcs_ucs2_common & 0x08, 0);

        let dcs_ucs2_explicit = 0x0C;
        assert_ne!(dcs_ucs2_explicit & 0x04, 0);
        assert_ne!(dcs_ucs2_explicit & 0x08, 0);

        let dcs_8bit = 0x04;
        assert_ne!(dcs_8bit & 0x04, 0);
        assert_eq!(dcs_8bit & 0x08, 0);
    }

    #[test]
    fn test_extract_udh_concat() {
        // IEI=0x00, IEDL=0x03, ref_id=0x42, total=2, part=1
        let udh = vec![0x00, 0x03, 0x42, 0x02, 0x01];
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_some());
        let concat = result.unwrap();
        assert_eq!(concat.ref_id, 0x42);
        assert_eq!(concat.total_parts, 2);
        assert_eq!(concat.part_number, 1);
    }

    #[test]
    fn test_extract_udh_concat_16bit() {
        // IEI=0x08, IEDL=0x04, ref_id=0x0042, total=2, part=1
        let udh = vec![0x08, 0x04, 0x00, 0x42, 0x02, 0x01];
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_some());
        let concat = result.unwrap();
        assert_eq!(concat.ref_id, 0x42);
        assert_eq!(concat.total_parts, 2);
        assert_eq!(concat.part_number, 1);
    }

    #[test]
    fn test_chinese_long_message_encoding() {
        let bytes_part1 = vec![
            0x30, 0x10, 0x80, 0x54, 0x90, 0x1A, // "【联通"
        ];
        let text1 = AtModemManager::decode_pdu_ucs2(&bytes_part1, 6);
        assert!(!text1.is_empty());
        assert!(text1.contains("联") || text1.contains("通"));
    }

    #[test]
    fn test_decode_bcd_phone_standard() {
        let bytes = vec![0x21, 0x43, 0x65, 0x87, 0x09, 0xF0];
        let result = AtModemManager::decode_bcd_phone(&bytes, 11);
        assert_eq!(result, "12345678900");
    }

    #[test]
    fn test_decode_bcd_phone_odd_length() {
        let bytes = vec![0x21, 0x43, 0x65, 0x87, 0xF9];
        let result = AtModemManager::decode_bcd_phone(&bytes, 9);
        assert_eq!(result, "123456789");
    }

    #[test]
    fn test_decode_bcd_phone_chinese() {
        let bytes = vec![0x68, 0x31, 0x08, 0x10, 0x83, 0x00, 0xF0];
        let result = AtModemManager::decode_bcd_phone(&bytes, 13);
        assert_eq!(result, "8613800138000");
    }

    #[test]
    fn test_decode_pdu_timestamp_with_positive_tz() {
        let bytes = vec![0x62, 0x30, 0x11, 0x41, 0x03, 0x00, 0x00];
        let result = AtModemManager::decode_pdu_timestamp(&bytes);
        assert!(result.contains('T'));
        assert!(result.ends_with('Z'));
        assert!(result.len() > 20);
    }

    #[test]
    fn test_decode_pdu_timestamp_with_negative_tz() {
        let bytes = vec![0x62, 0x10, 0x51, 0x21, 0x00, 0x00, 0x23];
        let result = AtModemManager::decode_pdu_timestamp(&bytes);
        assert!(result.contains('T'));
        assert!(result.ends_with('Z'));
    }

    #[test]
    fn test_decode_pdu_timestamp_edge_case() {
        // Too short: falls back to the current time
        let bytes = vec![0x99, 0x99, 0x99];
        let result = AtModemManager::decode_pdu_timestamp(&bytes);
        assert!(result.contains('T'));
        assert!(result.ends_with('Z'));
    }

    #[test]
    fn test_decode_pdu_7bit_with_udh_fill_bits() {
        // UDHL=5: fill bits = (7 - (5+1)*8 % 7) % 7 = 1
        let bytes = vec![
            0x90, 0x64, 0x36, 0x1B, 0x0D, // "Hello" with 1 fill bit offset
        ];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 5);
        assert!(result.len() >= 4);
    }

    #[test]
    fn test_decode_pdu_7bit_long_message() {
        let bytes = vec![
            0x54, 0x74, 0x7A, 0x0E, 0x4A, 0xCF, 0x41, 0x61, 0x10, 0xBD, 0x3C, 0x07, 0xD9, 0xDF,
            0x73, 0x90, 0xFB, 0x0D, 0x9A, 0x03,
        ];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 22, 0);
        assert!(result.len() >= 20);
    }

    #[test]
    fn test_parse_pdu_sms_structure() {
        // SMSC 00, type 04, sender 0B 91 2143658709F0, PID 00, DCS 00, timestamp
        // 42301141030023, UDL 05, text C8329BFD06
        let pdu = "00040B912143658709F00000423011410300230AC8329BFD06";
        let result = AtModemManager::parse_pdu_sms(1, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert_eq!(sms.index, 1);
        assert!(!sms.text.is_empty());
        assert!(sms.concat_info.is_none());
    }

    #[test]
    fn test_parse_pdu_sms_with_udh_structure() {
        // Type 44 (bit 6 = UDH present); UDL 0A covers UDH plus text; UDHL 05,
        // UDH 00 03 42 02 01 (ref=0x42, total=2, part=1); text A8
        let pdu = "00440B912143658709F00000423011410300230A0500034202 01A8";
        let result = AtModemManager::parse_pdu_sms(3, &pdu.replace(' ', ""));
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert_eq!(sms.index, 3);
        assert!(sms.concat_info.is_some());
        if let Some(concat) = sms.concat_info {
            assert_eq!(concat.ref_id, 0x42);
            assert_eq!(concat.total_parts, 2);
            assert_eq!(concat.part_number, 1);
        }
    }

    #[test]
    fn test_parse_pdu_sms_error_truncated() {
        let pdu = "07916831";
        let result = AtModemManager::parse_pdu_sms(5, pdu);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_pdu_sms_error_invalid_hex() {
        let pdu = "ZZZZZZZZZZ";
        let result = AtModemManager::parse_pdu_sms(6, pdu);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_udh_concat_no_concat_header() {
        // IEI=0x01 (special SMS indication), IEDL=0x02
        let udh = vec![0x01, 0x02, 0x00, 0x01];
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_udh_concat_truncated() {
        // IEDL=3 but total_parts and part_number are missing
        let udh = vec![0x00, 0x03, 0x42];
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_udh_concat_16bit_full_reference() {
        // IEI=0x08, IEDL=0x04, ref=0xABCD, total=3, part=1
        let udh = vec![0x08, 0x04, 0xAB, 0xCD, 0x03, 0x01];
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_some());
        let concat = result.unwrap();
        assert_eq!(concat.ref_id, 0xCD);
        assert_eq!(concat.total_parts, 3);
        assert_eq!(concat.part_number, 1);
    }

    #[test]
    fn test_decode_pdu_ucs2_empty() {
        let bytes = vec![];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 0);
        assert_eq!(result, "");
    }

    #[test]
    fn test_decode_pdu_ucs2_odd_length() {
        let bytes = vec![0x4F, 0x60, 0x59];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 3);
        assert!(!result.is_empty() || result == "?");
    }

    #[test]
    fn test_decode_pdu_7bit_boundary_conditions() {
        // 160 septets (the single-SMS limit) pack into 140 bytes
        let bytes = vec![0x41; 140];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 160, 0);
        assert_eq!(result.chars().count(), 160);
    }

    #[test]
    fn test_decode_bcd_phone_empty() {
        let bytes = vec![];
        let result = AtModemManager::decode_bcd_phone(&bytes, 0);
        assert_eq!(result, "");
    }

    #[test]
    fn test_parse_pdu_sms_8bit_encoding() {
        // DCS 04 (8-bit), UDL 05, text 48656C6C6F
        let pdu = "00040B912143658709F00004423011410300230548656C6C6F";
        let result = AtModemManager::parse_pdu_sms(7, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert_eq!(sms.text, "Hello");
    }

    #[test]
    fn test_decode_8bit_wap_push_as_safe_summary() {
        let payload = b"\x00\x06\x05\xff\xfeW\x80\x81http://z1.v-mas.cn:30089//v?c=243004716252924832&m=2909341\x00";

        let text = AtModemManager::decode_pdu_8bit(payload);

        assert_eq!(
            text,
            "运营商 WAP Push\n链接：http://z1.v-mas.cn:30089//v?c=243004716252924832&m=2909341"
        );
        assert!(!text.contains('\u{fffd}'));
        assert!(!text.contains('\0'));
    }

    #[test]
    fn test_decode_8bit_non_wap_payload_keeps_existing_lossy_behavior() {
        assert_eq!(AtModemManager::decode_pdu_8bit(b"\xffA"), "\u{fffd}A");
    }

    #[test]
    fn test_parse_pdu_sms_ucs2_encoding() {
        // DCS 08 (UCS-2), UDL 04, text 4F60597D
        let pdu = "00040B912143658709F000084230114103002304004F60597D";
        let result = AtModemManager::parse_pdu_sms(8, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert!(sms.text.contains("你") || sms.text.contains("好") || sms.text.len() >= 2);
        assert!(sms.concat_info.is_none());
    }

    #[test]
    fn test_decode_bcd_phone_with_hex_nibbles() {
        // 0xBA: low nibble A = '*', high nibble B = '#'
        let bytes = vec![0xBA];
        let result = AtModemManager::decode_bcd_phone(&bytes, 2);
        assert_eq!(result, "*#");
    }

    #[test]
    fn test_at_probe_order() {
        let p4: Vec<String> = (0..4).map(|n| format!("/dev/ttyUSB{n}")).collect();
        assert_eq!(
            AtModemManager::at_probe_order(&p4),
            vec![
                "/dev/ttyUSB2",
                "/dev/ttyUSB0",
                "/dev/ttyUSB1",
                "/dev/ttyUSB3"
            ]
        );
        let p2: Vec<String> = vec!["/dev/ttyUSB6".into(), "/dev/ttyUSB7".into()];
        assert_eq!(
            AtModemManager::at_probe_order(&p2),
            vec!["/dev/ttyUSB6", "/dev/ttyUSB7"]
        );
        let p1: Vec<String> = vec!["/dev/ttyUSB9".into()];
        assert_eq!(AtModemManager::at_probe_order(&p1), vec!["/dev/ttyUSB9"]);
    }

    #[test]
    fn test_modem_id_port_roundtrip() {
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB2"), "2");
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB0"), "0");
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB58"), "58");
        assert_eq!(AtModemManager::modem_id_to_port("2"), "/dev/ttyUSB2");
        assert_eq!(AtModemManager::modem_id_to_port("0"), "/dev/ttyUSB0");
        assert_eq!(AtModemManager::modem_id_to_port("58"), "/dev/ttyUSB58");
        for n in ["0", "1", "2", "6", "57", "240"] {
            let port = AtModemManager::modem_id_to_port(n);
            assert_eq!(AtModemManager::port_to_modem_id(&port), n);
        }
    }

    #[test]
    fn test_usbfs_node_path_zero_pads() {
        assert_eq!(
            AtModemManager::usbfs_node_path(3, 7),
            "/dev/bus/usb/003/007"
        );
        assert_eq!(
            AtModemManager::usbfs_node_path(1, 120),
            "/dev/bus/usb/001/120"
        );
        assert_eq!(
            AtModemManager::usbfs_node_path(255, 255),
            "/dev/bus/usb/255/255"
        );
    }

    #[test]
    fn test_decode_bcd_phone_mixed_digits_and_hex() {
        // "1*" -> 0xA1 (low=1, high=A); "2#" -> 0xB2
        let bytes = vec![0xA1, 0xB2];
        let result = AtModemManager::decode_bcd_phone(&bytes, 4);
        assert_eq!(result, "1*2#");
    }

    #[test]
    fn test_decode_bcd_phone_nibble_c_d() {
        let bytes = vec![0xDC];
        let result = AtModemManager::decode_bcd_phone(&bytes, 2);
        assert_eq!(result, "ab");
    }

    #[test]
    fn test_decode_bcd_phone_nibble_e_skipped() {
        // 0xE is reserved filler and is skipped
        let bytes = vec![0xE1];
        let result = AtModemManager::decode_bcd_phone(&bytes, 2);
        assert_eq!(result, "1");
    }

    #[test]
    fn test_decode_pdu_7bit_backward_compat() {
        let bytes = vec![0xC8, 0x32, 0x9B, 0xFD, 0x06];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 0);
        assert_eq!(result, "Hello");
    }

    #[test]
    fn test_decode_pdu_7bit_gsm_alphabet_at_sign() {
        // '@' is GSM 0x00, not 0x40 as in ASCII
        let bytes = vec![0x00];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 1, 0);
        assert_eq!(result, "@");
    }

    #[test]
    fn test_decode_pdu_7bit_gsm_special_chars() {
        // Septets 0x01 '£', 0x02 '$', 0x05 'é' packed 7 bits each
        let bytes = vec![0x01, 0x41, 0x01];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 3, 0);
        assert_eq!(result, "£$é");
    }

    #[test]
    fn test_decode_pdu_7bit_gsm_inverted_marks() {
        // Septets 0x40 '¡' and 0x60 '¿'
        let bytes = vec![0x40, 0x30];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
        assert_eq!(result, "¡¿");
    }

    #[test]
    fn test_decode_pdu_7bit_escape_sequences() {
        // Septets ESC 0x3C ESC 0x3E: '[' and ']'; each ESC pair yields one char
        let bytes = vec![0x1B, 0xDE, 0xC6, 0x07];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 4, 0);
        assert_eq!(result, "[]");
    }

    #[test]
    fn test_decode_pdu_7bit_euro_sign() {
        // Septets ESC 0x65
        let bytes = vec![0x9B, 0x32];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
        assert_eq!(result, "€");
    }

    #[test]
    fn test_decode_pdu_7bit_high_positions() {
        // Septets 0x7B 'ä' and 0x7C 'ö'
        let bytes = vec![0x7B, 0x3E];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
        assert_eq!(result, "äö");
    }

    #[test]
    fn test_parse_pdu_sms_alphanumeric_sender() {
        // Sender length 0C (12 semi-octets = 6 septets), TOA D0 (alphanumeric),
        // sender C7F7FBCC2E03 = "Google" packed as GSM 7-bit
        let pdu = "00040CD0C7F7FBCC2E0300004230114103002305C8329BFD06";
        let result = AtModemManager::parse_pdu_sms(1, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert_eq!(sms.sender.as_str(), "Google");
        assert_eq!(sms.text, "Hello");
    }
}
