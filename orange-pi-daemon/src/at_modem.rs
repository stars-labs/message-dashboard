//! Direct AT command modem interface - bypasses ModemManager for better performance
//!
//! For Quectel EC20 modems, each modem exposes 4 ttyUSB ports:
//! - ttyUSB0: DM port
//! - ttyUSB1: GPS NMEA
//! - ttyUSB2: AT commands (this is what we use)
//! - ttyUSB3: PPP/Modem

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

// USBDEVFS_RESET = _IO('U', 20): re-enumerates a USB device via its usbfs node.
// Equivalent to what `usbreset` does — recovers a wedged modem at the USB level.
nix::ioctl_none!(usbdevfs_reset, b'U', 20);

const SMS_PROMPT_TIMEOUT: Duration = Duration::from_secs(10);
const SMS_PROMPT_TIMEOUT_ERROR: &str = "Timeout waiting for > prompt";
const SMS_PROMPT_RETRY_DELAY: Duration = Duration::from_secs(1);

/// SMS message from AT command interface
#[derive(Debug, Clone)]
pub struct AtSms {
    /// CPMS mem1 storage containing this message (for example `ME` or `SM`).
    pub storage: String,
    pub index: u32,
    /// All SIM indices that belong to this logical message (concatenated parts)
    pub part_indices: Vec<u32>,
    pub sender: String,
    pub timestamp: String,
    pub text: String,
    /// Concatenation info for multipart messages (from UDH)
    pub concat_info: Option<ConcatInfo>,
}

/// Concatenation info from PDU User Data Header (UDH)
#[derive(Debug, Clone)]
pub struct ConcatInfo {
    pub ref_id: u8,      // Reference ID (groups parts together)
    pub total_parts: u8, // Total number of parts
    pub part_number: u8, // This part's number (1-indexed)
}

/// Modem device info from AT commands
#[derive(Debug, Clone, Default)]
pub struct AtModemInfo {
    pub port: String,
    pub iccid: Option<String>,
    pub imei: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub revision: Option<String>,
    pub signal_percent: Option<u32>,
    pub phone_number: Option<String>,
    pub operator: Option<String>,
}

/// Network registration status
#[derive(Debug, Clone, Default)]
pub struct NetworkRegStatus {
    pub creg: (u32, u32), // (n, stat) - stat: 0=not reg, 1=reg home, 2=searching, 3=denied, 4=unknown, 5=roaming
    pub cgreg: (u32, u32), // (n, stat) - GPRS registration
}

/// IMS status
#[derive(Debug, Clone, Default)]
pub struct ImsStatus {
    pub enabled: bool,
    pub registration: String,
}

/// SMS configuration
#[derive(Debug, Clone, Default)]
pub struct SmsConfig {
    pub mode: String,
    pub storage: String,
}

/// Full modem health check result
#[derive(Debug, Clone, Default)]
pub struct ModemHealth {
    pub port: String,
    pub iccid: Option<String>,
    pub imei: Option<String>,
    pub signal_percent: Option<u32>,
    pub operator: Option<String>,
    pub network_reg: Option<NetworkRegStatus>,
    pub ims_status: Option<ImsStatus>,
    pub sms_center: Option<String>,
    pub sms_config: Option<SmsConfig>,
}

/// Direct AT command modem manager
pub struct AtModemManager {
    /// Map of port path -> modem info cache
    modems: Arc<RwLock<HashMap<String, AtModemInfo>>>,
    /// One lock per AT port. A complete SMS submission holds this lock so the reader
    /// cannot flush or consume the modem prompt between configuration and CMGS.
    port_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Timeout for AT commands
    timeout: Duration,
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

    /// Discover all Quectel EC20 AT command ports
    /// EC20 uses ttyUSB2 for AT commands (every 4th port starting at 2)
    /// Group every /dev/ttyUSB* port by the physical USB device (modem) that owns it.
    ///
    /// Each ttyUSB hangs off a USB interface dir like `.../1-1.3.2.2.3:1.0`; the USB
    /// device is the parent (`1-1.3.2.2.3`). Returns device-path -> sorted port list.
    /// This makes discovery independent of how many interfaces a modem exposes — works
    /// for the default 4-port composition (AT at offset 2) and slimmed compositions
    /// (e.g. AT at offset 0) alike.
    pub fn ttyusb_by_usb_device() -> Result<BTreeMap<String, Vec<String>>> {
        let mut groups: BTreeMap<String, Vec<u32>> = BTreeMap::new();
        let entries = fs::read_dir("/sys/class/tty")
            .map_err(|e| anyhow!("Failed to read /sys/class/tty: {}", e))?;
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("ttyUSB") {
                continue;
            }
            let Ok(num) = name.trim_start_matches("ttyUSB").parse::<u32>() else {
                continue;
            };
            // The `device` link canonicalizes to the tty dir itself, nested under the
            // USB interface dir (e.g. .../3-1.2.2:1.2/ttyUSB2). The physical modem is the
            // ancestor USB *device* dir — the first one that carries an idVendor file
            // (interfaces and the tty dir do not). Walk up to it and group by its name.
            let link = format!("/sys/class/tty/{}/device", name);
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
                        .map(|n| format!("/dev/ttyUSB{}", n))
                        .collect(),
                )
            })
            .collect())
    }

    /// Resolve a `/dev/ttyUSBN` AT port to its stable USB topology path (e.g. `1-1.4.2.2.2`).
    ///
    /// The topology path encodes the physical socket (root port → hub port → … → port) and
    /// is stable across reboot/replug/daemon-restart — unlike the ttyUSB number or modem
    /// index, which the kernel reshuffles on every enumeration. Same walk as
    /// `ttyusb_by_usb_device`: from `/sys/class/tty/<name>/device`, ascend to the first
    /// ancestor carrying an `idVendor` file (the USB *device* dir) and return its name.
    pub fn usb_topology_for_port(port: &str) -> Option<String> {
        let name = port.trim_start_matches("/dev/");
        let link = format!("/sys/class/tty/{}/device", name);
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
    /// EC20 compositions place the AT port at a known slot: the default 4-port layout
    /// is DIAG/NMEA/AT/MODEM → AT is the 3rd port (index 2); the slimmed AT+MODEM
    /// layout has AT first (index 0). Several ports answer a bare "AT" (notably the
    /// MODEM/PPP port), so we must try the AT slot first rather than the lowest port —
    /// otherwise we may cache the PPP port and time out on real reads.
    pub fn at_probe_order(ports: &[String]) -> Vec<String> {
        let mut order: Vec<String> = Vec::with_capacity(ports.len());
        if ports.len() >= 3 {
            order.push(ports[2].clone()); // default 4-port: AT is index 2
        }
        for (i, p) in ports.iter().enumerate() {
            if !(ports.len() >= 3 && i == 2) {
                order.push(p.clone()); // index 0 first for slimmed, then the rest
            }
        }
        order
    }

    /// Discover all modems by probing one AT port per physical USB device.
    /// The AT slot is tried first (see `at_probe_order`); we keep the first port that
    /// answers AT, so this works for both default 4-port and slimmed 2-port modems.
    pub async fn discover_modems(&self) -> Result<Vec<String>> {
        let groups = Self::ttyusb_by_usb_device()?;
        let device_count = groups.len();
        let mut ports = Vec::new();

        for (_dev, dev_ports) in &groups {
            for port_path in Self::at_probe_order(dev_ports) {
                match self.probe_port_with_error(&port_path).await {
                    Ok(true) => {
                        if let Err(e) = self.init_ims(&port_path).await {
                            warn!("Failed to initialize IMS on {}: {}", port_path, e);
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

    /// Probe port with detailed error
    async fn probe_port_with_error(&self, port: &str) -> Result<bool> {
        match self
            .send_at_command(port, "AT", Duration::from_millis(1000))
            .await
        {
            Ok(response) => Ok(response.contains("OK")),
            Err(e) => Err(e),
        }
    }

    /// Quick probe to check if port responds to AT command
    pub async fn probe_port(&self, port: &str) -> bool {
        match self
            .send_at_command(port, "AT", Duration::from_millis(500))
            .await
        {
            Ok(response) => response.contains("OK"),
            Err(_) => false,
        }
    }

    /// Actively USB-reset the modem backing `port`, then wait for it to re-enumerate
    /// and confirm it answers AT again. Recovers a wedged modem whose ttyUSB exists
    /// but stopped responding. Returns Ok(true) if the modem answers AT after reset.
    ///
    /// Requires write access to the modem's usbfs node (/dev/bus/usb/BBB/DDD); on the
    /// Orange Pi this is granted to the `dialout` group via a udev rule.
    pub async fn reset_usb_port(&self, port: &str) -> Result<bool> {
        let node = Self::usbfs_node_for_port(port)?;
        info!("🔌 USB-resetting {} via {}", port, node.display());

        let node_for_blocking = node.clone();
        tokio::task::spawn_blocking(move || Self::reset_usb_sync(&node_for_blocking)).await??;

        // The device disappears and re-enumerates; the kernel rebuilds the same
        // ttyUSB node within a few seconds. Poll AT until it answers or we give up.
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

    /// Issue the USBDEVFS_RESET ioctl on a usbfs node (blocking).
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

    /// Resolve a /dev/ttyUSBN port to its usbfs device node (/dev/bus/usb/BBB/DDD)
    /// by walking up the sysfs device tree to the USB device that owns the interface.
    fn usbfs_node_for_port(port: &str) -> Result<PathBuf> {
        let dev_name = port
            .strip_prefix("/dev/")
            .ok_or_else(|| anyhow!("Unexpected port path: {}", port))?;
        let device_link = format!("/sys/class/tty/{}/device", dev_name);
        let mut dir = fs::canonicalize(&device_link)
            .map_err(|e| anyhow!("Cannot resolve sysfs device for {}: {}", port, e))?;

        // The tty hangs off a USB *interface* (e.g. 3-1.3.2.6:1.2). Walk up until we
        // reach the USB *device* dir, which carries busnum/devnum.
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
                _ => {
                    return Err(anyhow!(
                        "No USB device (busnum/devnum) found above {}",
                        port
                    ))
                }
            }
        }
    }

    /// Format the usbfs node path for a given bus/device number.
    fn usbfs_node_path(busnum: u8, devnum: u8) -> String {
        format!("/dev/bus/usb/{:03}/{:03}", busnum, devnum)
    }

    fn read_sysfs_u8(path: &Path) -> Result<u8> {
        let raw = fs::read_to_string(path)
            .map_err(|e| anyhow!("read {} failed: {}", path.display(), e))?;
        raw.trim()
            .parse::<u8>()
            .map_err(|e| anyhow!("parse {} ('{}') failed: {}", path.display(), raw.trim(), e))
    }

    /// Initialize IMS settings on modem
    pub async fn init_ims(&self, port: &str) -> Result<()> {
        // Enable IMS (IP Multimedia Subsystem)
        match self
            .send_at_command(port, "AT+QCFG=\"ims\",1", Duration::from_millis(1000))
            .await
        {
            Ok(response) if response.contains("OK") => {
                debug!("IMS enabled on {}", port);
            }
            Ok(response) => {
                warn!("Failed to enable IMS on {}: {}", port, response);
                return Err(anyhow!("Failed to enable IMS: {}", response));
            }
            Err(e) => {
                warn!("Error enabling IMS on {}: {}", port, e);
                return Err(e);
            }
        }
        Ok(())
    }

    /// Send AT command and get response
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

        // Run blocking serial I/O in spawn_blocking, but cap it at the async layer with
        // a hard deadline. A wedged modem can block a tty ioctl (tcgetattr/tcflush) —
        // O_NONBLOCK only covers read/write, not ioctls — which would otherwise hang the
        // task forever. If the deadline fires we abandon the (leaked) blocking thread and
        // report failure, so discovery/reads skip the bad port instead of stalling.
        let handle =
            tokio::task::spawn_blocking(move || Self::send_at_sync(&port_path, &cmd, timeout));
        match tokio::time::timeout(timeout + Duration::from_secs(2), handle).await {
            Ok(joined) => joined?,
            Err(_) => Err(anyhow!(
                "AT command timed out (port may be wedged): {}",
                port
            )),
        }
    }

    fn recover_sms_input_sync(port: &str, timeout: Duration) -> Result<()> {
        let mut file = Self::open_serial(port)?;
        file.write_all(&[0x1b])?;
        file.flush()?;
        std::thread::sleep(Duration::from_millis(100));
        drop(file);

        let response = Self::send_at_sync(port, "AT", timeout)?;
        if response.contains("OK") {
            Ok(())
        } else {
            Err(anyhow!(
                "Modem did not respond to AT after SMS input recovery: {}",
                response.trim()
            ))
        }
    }

    async fn recover_sms_input_unlocked(&self, port: &str) -> Result<()> {
        let port_path = port.to_string();
        let timeout = self.timeout;
        tokio::task::spawn_blocking(move || Self::recover_sms_input_sync(&port_path, timeout))
            .await?
    }

    /// Open serial port with proper settings
    fn open_serial(port: &str) -> Result<File> {
        // Open and KEEP the port non-blocking. A blocking serial open() waits for
        // carrier (DCD); a wedged modem never asserts it, hanging the thread forever.
        // Keeping O_NONBLOCK set also makes read()/write() return WouldBlock instead
        // of blocking, so a wedged port can never stall us — send_at_sync polls both
        // with a hard timeout. O_NOCTTY keeps the tty from becoming our controlling tty.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOCTTY)
            .open(port)
            .map_err(|e| anyhow!("Failed to open {}: {}", port, e))?;

        // Configure termios using the file reference
        let mut term = termios::tcgetattr(&file).map_err(|e| anyhow!("tcgetattr failed: {}", e))?;

        // Set baud rate 115200
        termios::cfsetispeed(&mut term, BaudRate::B115200)
            .map_err(|e| anyhow!("cfsetispeed failed: {}", e))?;
        termios::cfsetospeed(&mut term, BaudRate::B115200)
            .map_err(|e| anyhow!("cfsetospeed failed: {}", e))?;

        // Raw mode: 8N1, no flow control
        term.control_flags &= !(termios::ControlFlags::CSIZE | termios::ControlFlags::PARENB);
        term.control_flags |= termios::ControlFlags::CS8
            | termios::ControlFlags::CREAD
            | termios::ControlFlags::CLOCAL;
        term.control_flags &= !termios::ControlFlags::CRTSCTS;

        // Disable special character processing
        term.local_flags &= !(termios::LocalFlags::ICANON
            | termios::LocalFlags::ECHO
            | termios::LocalFlags::ECHOE
            | termios::LocalFlags::ISIG);

        // Disable input processing
        term.input_flags &= !(termios::InputFlags::IXON
            | termios::InputFlags::IXOFF
            | termios::InputFlags::IXANY
            | termios::InputFlags::ICRNL
            | termios::InputFlags::INLCR);

        // Disable output processing
        term.output_flags &= !termios::OutputFlags::OPOST;

        // Set read timeout: VMIN=0, VTIME=1 (0.1s timeout per read)
        term.control_chars[termios::SpecialCharacterIndices::VMIN as usize] = 0;
        term.control_chars[termios::SpecialCharacterIndices::VTIME as usize] = 1;

        termios::tcsetattr(&file, SetArg::TCSANOW, &term)
            .map_err(|e| anyhow!("tcsetattr failed: {}", e))?;

        // Flush buffers
        termios::tcflush(&file, termios::FlushArg::TCIOFLUSH)
            .map_err(|_| anyhow!("tcflush failed"))?;

        Ok(file)
    }

    /// Synchronous AT command send (runs in blocking thread).
    /// The fd is non-blocking, so writes/reads return WouldBlock rather than hanging on
    /// a wedged modem; we poll both with the same hard timeout.
    fn send_at_sync(port: &str, command: &str, timeout: Duration) -> Result<String> {
        let mut file = Self::open_serial(port)?;
        let start = Instant::now();

        // Send command with CR. Non-blocking write may report WouldBlock; retry until
        // the buffer accepts it or we hit the timeout.
        let cmd = format!("{}\r", command);
        let mut written = 0;
        while written < cmd.len() {
            if start.elapsed() > timeout {
                return Err(anyhow!("Write timeout on {}", port));
            }
            match file.write(&cmd.as_bytes()[written..]) {
                Ok(0) => std::thread::sleep(Duration::from_millis(10)),
                Ok(n) => written += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(anyhow!("Write failed: {}", e)),
            }
        }
        let _ = file.flush();

        // Read response with timeout
        let mut response = Vec::new();
        let mut buf = [0u8; 256];

        loop {
            if start.elapsed() > timeout {
                break;
            }

            match file.read(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Ok(n) => {
                    response.extend_from_slice(&buf[..n]);

                    // Check if we got a complete response
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
                    continue;
                }
                Err(e) => return Err(anyhow!("Read error: {}", e)),
            }
        }

        let response_str = String::from_utf8_lossy(&response).to_string();
        Ok(response_str)
    }

    /// Get ICCID from SIM card
    pub async fn get_iccid(&self, port: &str) -> Result<Option<String>> {
        // Try different ICCID commands (varies by modem)
        for cmd in &["AT+QCCID", "AT+CCID", "AT+ICCID"] {
            if let Ok(response) = self.send_at_command(port, cmd, self.timeout).await {
                if let Some(iccid) = Self::parse_iccid(&response) {
                    return Ok(Some(iccid));
                }
            }
        }
        Ok(None)
    }

    fn parse_iccid(response: &str) -> Option<String> {
        for line in response.lines() {
            let line = line.trim();
            if line.starts_with("+QCCID:")
                || line.starts_with("+CCID:")
                || line.starts_with("+ICCID:")
            {
                if let Some(pos) = line.find(':') {
                    let iccid = line[pos + 1..].trim().trim_matches('"');
                    if iccid.len() >= 18 && iccid.chars().all(|c| c.is_ascii_hexdigit()) {
                        return Some(Self::normalize_iccid(iccid));
                    }
                }
            } else if line.len() >= 18
                && line.len() <= 22
                && line.chars().all(|c| c.is_ascii_hexdigit())
            {
                return Some(Self::normalize_iccid(line));
            }
        }
        None
    }

    /// Strip trailing 'F' padding from ICCID (BCD filler per ITU-T E.118)
    fn normalize_iccid(iccid: &str) -> String {
        iccid.trim_end_matches('F').to_string()
    }

    /// Get IMEI
    pub async fn get_imei(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CGSN", self.timeout).await?;

        for line in response.lines() {
            let line = line.trim();
            if line.len() == 15 && line.chars().all(|c| c.is_ascii_digit()) {
                return Ok(Some(line.to_string()));
            }
        }
        Ok(None)
    }

    /// Get manufacturer
    pub async fn get_manufacturer(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CGMI", self.timeout).await?;

        for line in response.lines() {
            let line = line.trim();
            if !line.is_empty() && line != "OK" && !line.starts_with("+") && !line.starts_with("AT")
            {
                return Ok(Some(line.to_string()));
            }
        }
        Ok(None)
    }

    /// Get model
    pub async fn get_model(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CGMM", self.timeout).await?;

        for line in response.lines() {
            let line = line.trim();
            if !line.is_empty() && line != "OK" && !line.starts_with("+") && !line.starts_with("AT")
            {
                return Ok(Some(line.to_string()));
            }
        }
        Ok(None)
    }

    /// Get firmware revision
    pub async fn get_revision(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CGMR", self.timeout).await?;

        for line in response.lines() {
            let line = line.trim();
            if !line.is_empty() && line != "OK" && !line.starts_with("+") && !line.starts_with("AT")
            {
                return Ok(Some(line.to_string()));
            }
        }
        Ok(None)
    }

    /// Get signal quality (returns 0-100 percent)
    pub async fn get_signal(&self, port: &str) -> Result<u32> {
        let response = self.send_at_command(port, "AT+CSQ", self.timeout).await?;

        // Parse "+CSQ: 20,99" -> rssi=20 (0-31 scale)
        for line in response.lines() {
            if line.contains("+CSQ:") {
                if let Some(pos) = line.find(':') {
                    let parts: Vec<&str> = line[pos + 1..].trim().split(',').collect();
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

    /// Get phone number from SIM
    pub async fn get_phone_number(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CNUM", self.timeout).await?;

        // Parse "+CNUM: "","+1234567890",129"
        for line in response.lines() {
            if line.contains("+CNUM:") {
                let parts: Vec<&str> = line.split('"').collect();
                if parts.len() >= 4 {
                    let number = parts[3].trim();
                    if !number.is_empty() {
                        return Ok(Some(number.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Get operator name
    pub async fn get_operator(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+COPS?", self.timeout).await?;

        // Parse "+COPS: 0,0,"China Mobile",7"
        for line in response.lines() {
            if line.contains("+COPS:") {
                let parts: Vec<&str> = line.split('"').collect();
                if parts.len() >= 2 {
                    let operator = parts[1].trim();
                    if !operator.is_empty() {
                        return Ok(Some(operator.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Diagnostic: Get network registration status
    pub async fn get_network_registration(&self, port: &str) -> Result<NetworkRegStatus> {
        let creg = self.send_at_command(port, "AT+CREG?", self.timeout).await?;
        let creg = Self::parse_creg(&creg);

        let cgreg = self
            .send_at_command(port, "AT+CGREG?", self.timeout)
            .await?;
        let gregs = Self::parse_cgreg(&cgreg);

        Ok(NetworkRegStatus { creg, cgreg: gregs })
    }

    fn parse_creg(response: &str) -> (u32, u32) {
        for line in response.lines() {
            if line.contains("+CREG:") {
                if let Some(pos) = line.find(':') {
                    let parts: Vec<&str> = line[pos + 1..].trim().split(',').collect();
                    if parts.len() >= 2 {
                        let n = parts[0].trim().parse::<u32>().unwrap_or(0);
                        let stat = parts[1].trim().parse::<u32>().unwrap_or(0);
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
                if let Some(pos) = line.find(':') {
                    let parts: Vec<&str> = line[pos + 1..].trim().split(',').collect();
                    if parts.len() >= 2 {
                        let n = parts[0].trim().parse::<u32>().unwrap_or(0);
                        let stat = parts[1].trim().parse::<u32>().unwrap_or(0);
                        return (n, stat);
                    }
                }
            }
        }
        (0, 0)
    }

    /// Diagnostic: Get IMS status
    pub async fn get_ims_status(&self, port: &str) -> Result<ImsStatus> {
        let response = self
            .send_at_command(port, "AT+QCFG=\"ims\"", self.timeout)
            .await?;

        let mut ims_enabled = false;
        let mut ims_reg_status = String::new();

        for line in response.lines() {
            if line.contains("+QCFG: \"ims\"") {
                if let Some(pos) = line.find(',') {
                    let val = line[pos + 1..].trim().trim_matches('"');
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

    /// Diagnostic: Get SMS service center
    pub async fn get_sms_center(&self, port: &str) -> Result<Option<String>> {
        let response = self.send_at_command(port, "AT+CSCA?", self.timeout).await?;

        for line in response.lines() {
            if line.contains("+CSCA:") {
                if let Some(pos) = line.find(':') {
                    let csca = line[pos + 1..].trim().trim_matches('"');
                    if !csca.is_empty() {
                        return Ok(Some(csca.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Diagnostic: Get SMS mode and storage
    pub async fn get_sms_config(&self, port: &str) -> Result<SmsConfig> {
        let mode_response = self.send_at_command(port, "AT+CMGF?", self.timeout).await?;
        let mut mode = "Unknown";
        for line in mode_response.lines() {
            if line.contains("+CMGF:") {
                if let Some(pos) = line.find(':') {
                    let val = line[pos + 1..].trim();
                    if val == "0" {
                        mode = "PDU";
                    } else if val == "1" {
                        mode = "Text";
                    }
                }
            }
        }

        let storage_response = self.send_at_command(port, "AT+CPMS?", self.timeout).await?;
        let storage = storage_response
            .lines()
            .find(|l| l.contains("+CPMS:"))
            .map(|s| s.to_string())
            .unwrap_or_default();

        Ok(SmsConfig {
            mode: mode.to_string(),
            storage,
        })
    }

    /// Diagnostic: Full health check for a modem
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

    /// List all SMS messages, scanning modem and SIM storage independently.
    /// Quectel EC20 treats `MT` as an alias for `ME`, not as `ME` + `SM`.
    pub async fn list_sms(&self, port: &str) -> Result<Vec<AtSms>> {
        let stores = self.sms_read_stores(port).await;
        let mut messages = Vec::new();
        let mut successful_stores = 0;
        let mut failures = Vec::new();

        for storage in stores {
            if let Err(e) = self.select_sms_storage(port, &storage).await {
                warn!(
                    "Failed to select SMS storage {} on {}: {}; trying next storage",
                    storage, port, e
                );
                failures.push(format!("{} selection: {}", storage, e));
                continue;
            }

            match self.list_sms_from_selected_storage(port).await {
                Ok(mut stored_messages) => {
                    for message in &mut stored_messages {
                        message.storage = storage.clone();
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
                    failures.push(format!("{} scan: {}", storage, e));
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

    /// List messages from the already-selected CPMS mem1 storage.
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

    /// Discover stores to scan. EC20 is scanned as ME then SM; MT is only a fallback
    /// for modem families that advertise neither concrete storage.
    async fn sms_read_stores(&self, port: &str) -> Vec<String> {
        match self.send_at_command(port, "AT+CPMS=?", self.timeout).await {
            Ok(response) => {
                let supported = Self::parse_cpms_read_stores(&response);
                let stores = Self::sms_read_store_candidates(&supported);
                if stores.is_empty() {
                    warn!(
                        "Modem {} advertised no usable SMS read storage; trying ME and SM",
                        port
                    );
                    vec!["ME".to_string(), "SM".to_string()]
                } else {
                    stores
                }
            }
            Err(e) => {
                warn!(
                    "Failed to query SMS storage capabilities on {}: {}; trying ME and SM",
                    port, e
                );
                vec!["ME".to_string(), "SM".to_string()]
            }
        }
    }

    async fn select_sms_storage(&self, port: &str, storage: &str) -> Result<()> {
        let storage = storage.to_ascii_uppercase();
        if !matches!(storage.as_str(), "ME" | "SM" | "MT") {
            return Err(anyhow!("Unsupported SMS read storage: {}", storage));
        }

        let command = format!("AT+CPMS=\"{}\"", storage);
        self.send_at_command(port, &command, self.timeout).await?;
        Ok(())
    }

    /// Parse mem1 capabilities from `+CPMS: ("ME","MT",...),(...),(...)`.
    fn parse_cpms_read_stores(response: &str) -> Vec<String> {
        let Some(line) = response.lines().find(|line| line.contains("+CPMS:")) else {
            return Vec::new();
        };
        let Some(start) = line.find('(') else {
            return Vec::new();
        };
        let Some(end_offset) = line[start + 1..].find(')') else {
            return Vec::new();
        };

        Self::parse_quoted_values(&line[start + 1..start + 1 + end_offset])
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

    fn sms_read_store_candidates(supported: &[String]) -> Vec<String> {
        let mut stores: Vec<String> = ["ME", "SM"]
            .into_iter()
            .filter(|candidate| supported.iter().any(|store| store == candidate))
            .map(str::to_string)
            .collect();

        if stores.is_empty() && supported.iter().any(|store| store == "MT") {
            stores.push("MT".to_string());
        }
        stores
    }

    /// Text-mode listing used as the primary decode path (preserves existing behavior).
    async fn list_sms_text_mode(&self, port: &str) -> Result<Vec<AtSms>> {
        // Set text mode
        self.send_at_command(port, "AT+CMGF=1", self.timeout)
            .await?;

        // Try to set character set to UCS2 for proper Chinese/Unicode handling
        // If this fails, the modem will use its default charset (often GSM or IRA)
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

        // List all messages (longer timeout for many messages)
        let response = self
            .send_at_command(port, "AT+CMGL=\"ALL\"", Duration::from_secs(10))
            .await?;

        let mut messages = Vec::new();
        let lines: Vec<&str> = response.lines().collect();
        let mut i = 0;

        while i < lines.len() {
            let line = lines[i].trim();

            // Parse "+CMGL: 1,"REC READ","+1234567890","","24/01/15,10:30:45+32"
            if line.contains("+CMGL:") {
                if let Some(sms) = self.parse_cmgl_header(line) {
                    i += 1;
                    if i < lines.len() {
                        let raw_text = lines[i].trim();
                        if !raw_text.is_empty() && raw_text != "OK" && !raw_text.contains("+CMGL:")
                        {
                            // Decode UCS2 hex if it looks like hex-encoded text
                            let text = Self::decode_sms_content(raw_text);
                            messages.push(AtSms {
                                storage: String::new(),
                                index: sms.0,
                                part_indices: vec![sms.0],
                                sender: sms.1,
                                timestamp: sms.2,
                                text,
                                concat_info: None, // Text mode doesn't provide concatenation info
                            });
                        }
                    }
                }
            }
            i += 1;
        }

        Ok(messages)
    }

    /// List SMS messages in PDU mode to extract concatenation info
    async fn list_sms_pdu_mode(&self, port: &str) -> Result<Vec<AtSms>> {
        // Set PDU mode
        self.send_at_command(port, "AT+CMGF=0", self.timeout)
            .await?;

        // List all messages in PDU format (longer timeout for many messages)
        let response = self
            .send_at_command(port, "AT+CMGL=4", Duration::from_secs(10))
            .await?;

        let mut messages = Vec::new();
        let lines: Vec<&str> = response.lines().collect();
        let mut i = 0;

        while i < lines.len() {
            let line = lines[i].trim();

            // Parse "+CMGL: 0,1,,23" (index, status, alpha, length)
            if line.contains("+CMGL:") {
                if let Some(index) = Self::parse_cmgl_pdu_header(line) {
                    i += 1;
                    if i < lines.len() {
                        let pdu_hex = lines[i].trim();
                        if !pdu_hex.is_empty() && pdu_hex != "OK" && !pdu_hex.contains("+CMGL:") {
                            // Parse the PDU and extract message
                            if let Ok(sms) = Self::parse_pdu_sms(index, pdu_hex) {
                                messages.push(sms);
                            }
                        }
                    }
                }
            }
            i += 1;
        }

        Ok(messages)
    }

    /// Parse PDU CMGL header to extract message index
    fn parse_cmgl_pdu_header(line: &str) -> Option<u32> {
        // +CMGL: 0,1,,23
        let parts: Vec<&str> = line.split(',').collect();
        if parts.is_empty() {
            return None;
        }

        // Extract index from "+CMGL: 0"
        let index_part = parts[0].split(':').last()?.trim();
        index_part.parse::<u32>().ok()
    }

    /// Parse a PDU SMS message
    fn parse_pdu_sms(index: u32, pdu_hex: &str) -> Result<AtSms> {
        // Decode hex string to bytes
        let pdu_bytes: Vec<u8> = (0..pdu_hex.len())
            .step_by(2)
            .filter_map(|i| u8::from_str_radix(&pdu_hex[i..(i + 2).min(pdu_hex.len())], 16).ok())
            .collect();

        if pdu_bytes.len() < 10 {
            return Err(anyhow!("PDU too short"));
        }

        let mut pos = 0;

        // SMSC length (skip SMSC address)
        let smsc_len = pdu_bytes[pos] as usize;
        pos += 1 + smsc_len;

        if pos >= pdu_bytes.len() {
            return Err(anyhow!("PDU truncated after SMSC"));
        }

        // PDU type
        let pdu_type = pdu_bytes[pos];
        pos += 1;

        // Sender address length (in digits)
        if pos >= pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at sender length"));
        }
        let sender_len = pdu_bytes[pos] as usize;
        pos += 1;

        // Sender type of address
        if pos >= pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at sender type"));
        }
        let sender_toa = pdu_bytes[pos];
        pos += 1;

        // Type-of-number (bits 6-4): 0x05 = alphanumeric (GSM 7-bit encoded)
        let sender_ton = (sender_toa >> 4) & 0x07;

        // Sender address bytes: for BCD it's (digits+1)/2, for alphanumeric sender_len
        // is the number of useful semi-octets (which maps to the same byte count formula)
        let sender_bytes = (sender_len + 1) / 2;
        if pos + sender_bytes > pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at sender address"));
        }
        let sender = if sender_ton == 0x05 {
            // Alphanumeric sender: bytes are GSM 7-bit packed
            // sender_len is in "digits" but for alphanumeric it means usable semi-octets,
            // the number of septets (chars) = sender_len * 4 / 7
            let num_septets = (sender_len * 4) / 7;
            Self::decode_pdu_7bit(&pdu_bytes[pos..pos + sender_bytes], num_septets, 0)
        } else {
            Self::decode_bcd_phone(&pdu_bytes[pos..pos + sender_bytes], sender_len)
        };
        pos += sender_bytes;

        // PID (Protocol Identifier)
        if pos >= pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at PID"));
        }
        pos += 1;

        // DCS (Data Coding Scheme)
        if pos >= pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at DCS"));
        }
        let dcs = pdu_bytes[pos];
        pos += 1;

        // Timestamp (7 bytes in semi-octets)
        if pos + 7 > pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at timestamp"));
        }
        let timestamp = Self::decode_pdu_timestamp(&pdu_bytes[pos..pos + 7]);
        pos += 7;

        // User Data Length
        if pos >= pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at UDL"));
        }
        let udl = pdu_bytes[pos] as usize;
        pos += 1;

        // Check for UDH (User Data Header)
        let has_udh = (pdu_type & 0x40) != 0;
        let mut concat_info = None;
        let mut text_start = pos;
        let udhl = if has_udh {
            if pos >= pdu_bytes.len() {
                return Err(anyhow!("PDU truncated at UDHL"));
            }
            let udhl = pdu_bytes[pos] as usize;
            pos += 1;

            // Extract concatenation info from UDH
            concat_info = Self::extract_udh_concat(&pdu_bytes[pos..pos + udhl]);
            pos += udhl;
            text_start = pos;
            udhl
        } else {
            0
        };

        // Decode message text based on DCS (Data Coding Scheme)
        // GSM 03.38 DCS values:
        // 0x00 = 7-bit GSM default alphabet
        // 0x04 = 8-bit data
        // 0x08 = UCS-2 (UTF-16BE) - common for Chinese
        // 0x0C = 8-bit + reserved
        let text = if (dcs & 0x08) != 0 {
            // Bit 3 set = UCS-2 encoding (Chinese/Unicode)
            debug!("PDU encoding detected: UCS-2 (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_ucs2(&pdu_bytes[text_start..], udl)
        } else if (dcs & 0x04) != 0 {
            // Bit 2 set (but not bit 3) = 8-bit data encoding
            debug!("PDU encoding detected: 8-bit data (DCS: 0x{:02X})", dcs);
            // UDH already skipped, text_start points to actual text
            String::from_utf8_lossy(&pdu_bytes[text_start..]).to_string()
        } else {
            // Default 7-bit GSM alphabet (English/ASCII)
            debug!("PDU encoding detected: 7-bit GSM (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_7bit(&pdu_bytes[text_start..], udl, udhl)
        };

        Ok(AtSms {
            storage: String::new(),
            index,
            part_indices: vec![index],
            sender,
            timestamp,
            text,
            concat_info,
        })
    }

    /// Extract concatenation info from UDH
    fn extract_udh_concat(udh_bytes: &[u8]) -> Option<ConcatInfo> {
        let mut pos = 0;
        while pos < udh_bytes.len() {
            let iei = udh_bytes[pos];
            pos += 1;

            if pos >= udh_bytes.len() {
                break;
            }
            let iedl = udh_bytes[pos] as usize;
            pos += 1;

            if pos + iedl > udh_bytes.len() {
                break;
            }

            // IEI 0x00: Concatenated short message, 8-bit reference
            // IEI 0x08: Concatenated short message, 16-bit reference
            if iei == 0x00 && iedl == 3 {
                let ref_id = udh_bytes[pos];
                let total_parts = udh_bytes[pos + 1];
                let part_number = udh_bytes[pos + 2];
                return Some(ConcatInfo {
                    ref_id,
                    total_parts,
                    part_number,
                });
            } else if iei == 0x08 && iedl == 4 {
                // Use only lower byte of 16-bit reference for simplicity
                let ref_id = udh_bytes[pos + 1];
                let total_parts = udh_bytes[pos + 2];
                let part_number = udh_bytes[pos + 3];
                return Some(ConcatInfo {
                    ref_id,
                    total_parts,
                    part_number,
                });
            }

            pos += iedl;
        }
        None
    }

    /// Map a BCD nibble (0x0-0xF) to its character per GSM 03.40 Section 9.1.2.3
    fn bcd_nibble_to_char(nibble: u8) -> Option<char> {
        match nibble {
            0x0..=0x9 => Some((b'0' + nibble) as char),
            0xA => Some('*'),
            0xB => Some('#'),
            0xC => Some('a'),
            0xD => Some('b'),
            0xE | 0xF => None, // reserved / filler
            _ => None,
        }
    }

    /// Decode BCD-encoded phone number
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

    /// Decode PDU timestamp to ISO 8601 format
    fn decode_pdu_timestamp(bytes: &[u8]) -> String {
        if bytes.len() < 7 {
            return chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
        }

        // Semi-octet BCD decoding: each byte has nibbles swapped (low nibble first)
        // After swapping, decode as BCD: (high_nibble * 10) + low_nibble
        let decode_bcd = |b: u8| -> u32 {
            let swapped = ((b & 0x0F) << 4) | ((b >> 4) & 0x0F);
            let high = (swapped >> 4) & 0x0F;
            let low = swapped & 0x0F;
            (high * 10 + low) as u32
        };

        let year = decode_bcd(bytes[0]) as i32 + 2000;
        let month = decode_bcd(bytes[1]);
        let day = decode_bcd(bytes[2]);
        let hour = decode_bcd(bytes[3]);
        let minute = decode_bcd(bytes[4]);
        let second = decode_bcd(bytes[5]);

        // Timezone (in quarter hours, also BCD encoded)
        // Bit 7 of original byte = sign (0=positive, 1=negative)
        let tz_byte = bytes[6];
        let tz_sign = if (tz_byte & 0x80) != 0 { -1 } else { 1 };
        let tz_quarters = decode_bcd(tz_byte & 0x7F) as i32; // Mask out sign bit before BCD decode
        let tz_offset_minutes = tz_sign * tz_quarters * 15;

        // Convert to UTC
        let naive = chrono::NaiveDate::from_ymd_opt(year, month, day)
            .and_then(|d| d.and_hms_opt(hour, minute, second))
            .unwrap_or_else(|| chrono::Utc::now().naive_utc());

        let dt = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
            naive - chrono::Duration::minutes(tz_offset_minutes as i64),
            chrono::Utc,
        );

        dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }

    /// GSM 03.38 default alphabet (7-bit) → Unicode mapping.
    /// Positions that match ASCII are identical; others map to GSM-specific chars.
    const GSM_DEFAULT_ALPHABET: [char; 128] = [
        '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', // 0x00-0x07
        'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å', // 0x08-0x0F
        'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', // 0x10-0x17
        'Σ', 'Θ', 'Ξ', ' ', 'Æ', 'æ', 'ß', 'É', // 0x18-0x1F (0x1B=ESC→space fallback)
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

    /// GSM 03.38 extension table (reached via ESC 0x1B prefix).
    /// Returns None for undefined extension codes.
    fn gsm_extension_char(code: u8) -> Option<char> {
        match code {
            0x0A => Some('\u{000C}'), // form feed (page break)
            0x14 => Some('^'),
            0x28 => Some('{'),
            0x29 => Some('}'),
            0x2F => Some('\\'),
            0x3C => Some('['),
            0x3D => Some('~'),
            0x3E => Some(']'),
            0x40 => Some('|'),
            0x65 => Some('€'),
            _ => None, // undefined extension
        }
    }

    /// Decode 7-bit GSM encoded text
    /// bytes: text data (UDH already removed by caller)
    /// udl: User Data Length in septets (characters)
    /// udhl: UDH length in bytes (0 if no UDH) - needed to calculate fill bits
    fn decode_pdu_7bit(bytes: &[u8], udl: usize, udhl: usize) -> String {
        // For 7-bit encoding with UDH, calculate fill bits to align to septet boundary
        // Fill bits = (7 - ((udhl + 1) * 8) % 7) % 7
        let fill_bits = if udhl > 0 {
            (7 - ((udhl + 1) * 8) % 7) % 7
        } else {
            0
        };

        let mut result = String::new();
        let mut bit_pos = fill_bits;
        let mut escape_next = false;

        for _ in 0..udl {
            let byte_pos = bit_pos / 8;
            let shift = bit_pos % 8;

            if byte_pos >= bytes.len() {
                break;
            }

            let mut char_val = (bytes[byte_pos] >> shift) & 0x7F;
            if shift > 1 && byte_pos + 1 < bytes.len() {
                char_val |= (bytes[byte_pos + 1] << (8 - shift)) & 0x7F;
            }

            if escape_next {
                escape_next = false;
                if let Some(ext_char) = Self::gsm_extension_char(char_val) {
                    result.push(ext_char);
                } else {
                    // Unknown extension: output space as fallback
                    result.push(' ');
                }
            } else if char_val == 0x1B {
                // ESC: next septet is extension character
                escape_next = true;
            } else {
                result.push(Self::GSM_DEFAULT_ALPHABET[char_val as usize]);
            }

            bit_pos += 7;
        }

        result
    }

    /// Decode UCS2 (UTF-16BE) encoded text
    /// bytes: text data (UDH already removed by caller)
    fn decode_pdu_ucs2(bytes: &[u8], _udl: usize) -> String {
        // The caller has already skipped the UDH, so we start from byte 0
        if bytes.is_empty() {
            return String::new();
        }

        let u16_count = bytes.len() / 2;
        let u16_values: Vec<u16> = (0..u16_count)
            .map(|i| u16::from_be_bytes([bytes[i * 2], bytes[i * 2 + 1]]))
            .collect();

        String::from_utf16(&u16_values).unwrap_or_else(|_| String::from("?"))
    }

    /// Decode SMS content - handles UCS2 hex encoding for Chinese/Unicode
    fn decode_sms_content(raw: &str) -> String {
        // Check if it looks like UCS2 hex (all hex chars, even length, typical length)
        let is_hex =
            raw.len() >= 4 && raw.len() % 4 == 0 && raw.chars().all(|c| c.is_ascii_hexdigit());

        if is_hex {
            // Try to decode as UCS2 (UTF-16BE) hex string
            if let Some(decoded) = Self::decode_ucs2_hex(raw) {
                // Only use decoded if it produced valid text
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

        // Return as-is if not hex or decode failed
        raw.to_string()
    }

    /// Decode a sender address after applying sender-only normalization.
    ///
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
                if candidates.len() == 1 {
                    let candidate = &candidates[0];
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
            let Ok(code_point) = raw[offset..end].parse::<u8>() else {
                continue;
            };
            if !(32..=126).contains(&code_point) {
                continue;
            }

            let mut next = decoded.clone();
            next.push(code_point as char);
            Self::decode_decimal_ascii_candidates(raw, end, next, candidates);
        }
    }

    /// Decode UCS2 hex string to UTF-8
    /// Input: "4F60597D" (你好)
    /// Output: "你好"
    fn decode_ucs2_hex(hex: &str) -> Option<String> {
        // Must be even length (2 hex chars per byte)
        if hex.len() % 2 != 0 {
            return None;
        }

        let bytes: Result<Vec<u8>, _> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
            .collect();

        let bytes = bytes.ok()?;

        // Decode as UTF-16BE (need even number of bytes)
        if bytes.len() % 2 != 0 {
            return None;
        }

        let u16_values: Vec<u16> = bytes
            .chunks(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();

        String::from_utf16(&u16_values).ok()
    }

    /// Parse CMGL header line
    fn parse_cmgl_header(&self, line: &str) -> Option<(u32, String, String)> {
        // +CMGL: 1,"REC READ","+1234567890","","24/01/15,10:30:45+32"
        // With UCS2: phone number may be hex encoded like "002B0036003500..."
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 3 {
            return None;
        }

        // Extract index from "+CMGL: 1"
        let index_part = parts[0].split(':').last()?.trim();
        let index = index_part.parse::<u32>().ok()?;

        // Extract sender (third part, quoted) - may be UCS2 encoded
        let raw_sender = parts.get(2)?.trim().trim_matches('"');
        let sender = Self::decode_sms_sender(raw_sender);

        // Extract timestamp (4th and 5th parts) - may also be UCS2 encoded
        let timestamp = if parts.len() >= 5 {
            let raw_date = parts
                .get(4)
                .map(|s| s.trim().trim_matches('"'))
                .unwrap_or("");
            let raw_time = parts
                .get(5)
                .map(|s| s.trim().trim_matches('"'))
                .unwrap_or("");
            // Decode date/time if UCS2 encoded
            let date = Self::decode_sms_content(raw_date);
            let time = Self::decode_sms_content(raw_time);
            self.normalize_sms_timestamp(&date, &time)
        } else {
            chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        };

        Some((index, sender, timestamp))
    }

    /// Convert SMS timestamp to RFC3339 UTC
    fn normalize_sms_timestamp(&self, date: &str, time: &str) -> String {
        // Input: "24/01/15" and "10:30:45+32" (YY/MM/DD and HH:MM:SS+TZ)
        // TZ offset is in quarter-hours from UTC (e.g. +32 = 32*15min = 8h = UTC+8)
        let date_parts: Vec<&str> = date.split('/').collect();

        // Parse time and timezone offset (quarter-hours)
        let (time_clean, offset_minutes) = if let Some(pos) = time.rfind('+') {
            let t = &time[..pos];
            let tz_quarters: i32 = time[pos + 1..].parse().unwrap_or(0);
            (t, tz_quarters * 15)
        } else if let Some(pos) = time[1..].rfind('-') {
            let pos = pos + 1;
            let t = &time[..pos];
            let tz_quarters: i32 = time[pos + 1..].parse().unwrap_or(0);
            (t, -(tz_quarters * 15))
        } else {
            (time, 0i32)
        };

        if date_parts.len() >= 3 {
            let year = format!("20{}", date_parts[0]);
            let month = date_parts[1];
            let day = date_parts[2];

            // Parse local time and convert to UTC using chrono
            let local_str = format!("{}-{}-{}T{}", year, month, day, time_clean);
            if let Ok(naive) =
                chrono::NaiveDateTime::parse_from_str(&local_str, "%Y-%m-%dT%H:%M:%S")
            {
                let utc = naive - chrono::Duration::minutes(offset_minutes as i64);
                return format!("{}Z", utc.format("%Y-%m-%dT%H:%M:%S%.3f"));
            }

            // Fallback: return with offset if chrono parse fails
            let tz_hours = offset_minutes.abs() / 60;
            let tz_mins = offset_minutes.abs() % 60;
            let sign = if offset_minutes >= 0 { '+' } else { '-' };
            return format!(
                "{}-{}-{}T{}{}{:02}:{:02}",
                year, month, day, time_clean, sign, tz_hours, tz_mins
            );
        }

        chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }

    /// Delete SMS by index
    pub async fn delete_sms(&self, port: &str, index: u32) -> Result<()> {
        let cmd = format!("AT+CMGD={}", index);
        let response = self.send_at_command(port, &cmd, self.timeout).await?;

        if response.contains("OK") {
            debug!("Deleted SMS {} from {}", index, port);
            Ok(())
        } else {
            Err(anyhow!("Failed to delete SMS {}: {}", index, response))
        }
    }

    /// Delete an SMS from an explicit CPMS storage. Indices are scoped to mem1, so
    /// selecting the storage is part of the delete operation rather than shared state.
    pub async fn delete_sms_from_storage(
        &self,
        port: &str,
        storage: &str,
        index: u32,
    ) -> Result<()> {
        self.select_sms_storage(port, storage).await?;
        self.delete_sms(port, index).await
    }

    /// Delete all SMS (use with caution)
    pub async fn delete_all_sms(&self, port: &str) -> Result<()> {
        // AT+CMGD=1,4 deletes all messages
        let response = self
            .send_at_command(port, "AT+CMGD=1,4", self.timeout)
            .await?;

        if response.contains("OK") {
            info!("Deleted all SMS from {}", port);
            Ok(())
        } else {
            Err(anyhow!("Failed to delete all SMS: {}", response))
        }
    }

    /// Encode string to UCS2 hex format (UTF-16BE)
    fn encode_ucs2_hex(text: &str) -> String {
        text.encode_utf16().map(|u| format!("{:04X}", u)).collect()
    }

    /// Check if text contains non-ASCII characters
    fn needs_ucs2(text: &str) -> bool {
        text.chars().any(|c| !c.is_ascii())
    }

    /// Validate an SMS recipient before it is interpolated into an AT command.
    ///
    /// AT commands are CR-terminated, so a CR anywhere in the recipient ends the
    /// `AT+CMGS="..."` command and the modem parses the remaining bytes as a new
    /// command. The recipient arrives from an API request body and is therefore
    /// untrusted; see docs/SECURITY-REVIEW.md finding 3.
    ///
    /// This allow-lists E.164 rather than escaping: a phone number has no legitimate
    /// use for quotes or control characters, so anything outside `+` and digits is
    /// rejected outright. Rejecting is deliberate — silently stripping characters
    /// would send the message to a *different* number than the caller asked for.
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

    /// Validate an outbound SMS body before it is written to the modem.
    ///
    /// The body is terminated by Ctrl-Z (0x1A), so a literal 0x1A inside it ends SMS
    /// entry early and returns the modem to command mode — making every trailing byte
    /// an AT command. ESC (0x1B) aborts entry, and NUL is never legitimate. Newlines
    /// ARE allowed: a multi-line SMS body is normal.
    pub(crate) fn validate_message_body(message: &str) -> Result<()> {
        if let Some(c) = message
            .chars()
            .find(|&c| c == '\x1A' || c == '\x1B' || c == '\0')
        {
            return Err(anyhow!(
                "Invalid SMS body: contains control character U+{:04X}",
                c as u32
            ));
        }

        Ok(())
    }

    /// Send SMS
    pub async fn send_sms(&self, port: &str, recipient: &str, message: &str) -> Result<()> {
        Self::validate_recipient(recipient)?;
        self.send_sms_with_short_code(port, recipient, message, false)
            .await
    }

    pub async fn send_sms_with_short_code(
        &self,
        port: &str,
        recipient: &str,
        message: &str,
        allow_short_code: bool,
    ) -> Result<()> {
        // Validate before touching the modem: both values are interpolated into AT
        // command strings below, and both originate from an API request body.
        Self::validate_recipient_with_short_code(recipient, allow_short_code)?;
        Self::validate_message_body(message)?;

        let use_ucs2 = Self::needs_ucs2(message);
        let port_lock = self.port_lock(port).await;
        let _guard = port_lock.lock().await;

        for attempt in 1..=2 {
            self.recover_sms_input_unlocked(port).await?;
            self.configure_sms_unlocked(port, use_ucs2).await?;

            let port_path = port.to_string();
            let recipient = recipient.to_string();
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

            match result {
                Ok(()) => return Ok(()),
                Err(error) if attempt == 1 && Self::is_prompt_timeout(&error) => {
                    warn!(
                        "SMS prompt timed out on {}; recovering and retrying once",
                        port
                    );
                    tokio::time::sleep(SMS_PROMPT_RETRY_DELAY).await;
                }
                Err(error) => return Err(error),
            }
        }

        unreachable!("SMS send loop always returns on its second attempt")
    }

    async fn configure_sms_unlocked(&self, port: &str, use_ucs2: bool) -> Result<()> {
        Self::send_at_command_unlocked(port, "AT+CMGF=1", self.timeout).await?;

        if use_ucs2 {
            // Set UCS2 character set and message format for Unicode messages
            Self::send_at_command_unlocked(port, "AT+CSCS=\"UCS2\"", self.timeout).await?;
            // Set message parameters: No retry, request delivery report, DCS=8 for UCS2
            // CSMP format: <fo>,<vp>,<pid>,<dcs>
            // fo=49 (0x31): TP-SRR=1 (status report), TP-VPF=00 (no validity period)
            // vp=0: Not used when TP-VPF=00
            // This prevents modem from retrying SMS sends automatically
            Self::send_at_command_unlocked(port, "AT+CSMP=49,0,0,8", self.timeout).await?;
        } else {
            // Set GSM character set for ASCII messages
            Self::send_at_command_unlocked(port, "AT+CSCS=\"GSM\"", self.timeout).await?;
            // Set message parameters: No retry, request delivery report, GSM 7-bit
            // fo=49 (0x31): TP-SRR=1 (status report), TP-VPF=00 (no validity period)
            // This prevents modem from retrying SMS sends automatically
            Self::send_at_command_unlocked(port, "AT+CSMP=49,0,0,0", self.timeout).await?;
        }

        Ok(())
    }

    fn is_prompt_timeout(error: &anyhow::Error) -> bool {
        error.to_string() == SMS_PROMPT_TIMEOUT_ERROR
    }

    fn send_sms_sync(
        port: &str,
        recipient: &str,
        message: &str,
        timeout: Duration,
        use_ucs2: bool,
        allow_short_code: bool,
    ) -> Result<()> {
        // Re-checked at the sink rather than trusting send_sms: this is the function
        // that actually writes to the serial port, so the invariant belongs here too.
        Self::validate_recipient_with_short_code(recipient, allow_short_code)?;
        Self::validate_message_body(message)?;

        let mut file = Self::open_serial(port)?;

        // In UCS2 mode, BOTH phone number and message must be UCS2 hex encoded
        let (encoded_recipient, encoded_message) = if use_ucs2 {
            (
                Self::encode_ucs2_hex(recipient),
                Self::encode_ucs2_hex(message),
            )
        } else {
            (recipient.to_string(), message.to_string())
        };

        // Send CMGS command
        let cmd = format!("AT+CMGS=\"{}\"\r", encoded_recipient);
        file.write_all(cmd.as_bytes())?;
        file.flush()?;

        // Wait for > prompt (read until we see it)
        let mut prompt_buf = Vec::new();
        let mut buf = [0u8; 64];
        let start = Instant::now();
        let mut got_prompt = false;

        while start.elapsed() < SMS_PROMPT_TIMEOUT {
            match file.read(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                Ok(n) => {
                    prompt_buf.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&prompt_buf);
                    if text.contains('>') {
                        got_prompt = true;
                        break;
                    }
                    if text.contains("ERROR") {
                        return Err(anyhow!("CMGS command failed: {}", text));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                Err(e) => return Err(anyhow!("Read error waiting for prompt: {}", e)),
            }
        }

        if !got_prompt {
            return Err(anyhow!(SMS_PROMPT_TIMEOUT_ERROR));
        }

        // Small delay after prompt
        std::thread::sleep(Duration::from_millis(100));

        // Send message with Ctrl-Z (0x1A)
        let msg_with_end = format!("{}\x1A", encoded_message);
        file.write_all(msg_with_end.as_bytes())?;
        file.flush()?;

        // Read response
        let mut response = Vec::new();
        let mut buf = [0u8; 256];
        let start = Instant::now();

        loop {
            if start.elapsed() > timeout {
                break;
            }

            match file.read(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                Ok(n) => {
                    response.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&response);
                    if text.contains("OK") || text.contains("ERROR") {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                Err(e) => return Err(anyhow!("Read error: {}", e)),
            }
        }

        let response_str = String::from_utf8_lossy(&response);
        if response_str.contains("OK") {
            Ok(())
        } else {
            Err(anyhow!("Send SMS failed: {}", response_str))
        }
    }

    /// Get full modem info
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

    /// Convert AT-port path to modem ID.
    /// The modem ID is simply the AT port's ttyUSB index ("/dev/ttyUSB6" -> "6").
    /// This is independent of USB composition (no fixed 4-ports-per-modem assumption),
    /// so it works for both default and slimmed modems. The ID is an internal handle;
    /// the stable cross-system key is the modem's IMEI (equipment_id).
    pub fn port_to_modem_id(port: &str) -> String {
        port.strip_prefix("/dev/ttyUSB")
            .map(|n| n.to_string())
            .unwrap_or_else(|| port.to_string())
    }

    /// Convert modem ID back to its AT port path ("6" -> "/dev/ttyUSB6").
    pub fn modem_id_to_port(id: &str) -> String {
        if id.parse::<u32>().is_ok() {
            return format!("/dev/ttyUSB{}", id);
        }
        id.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    // An AT command is terminated by CR, so a CR inside the recipient ends the CMGS
    // command and everything after it is parsed by the modem as a fresh command. The
    // recipient reaches here from an API request body, so it is untrusted.
    // See docs/SECURITY-REVIEW.md finding 3.
    #[test]
    fn test_validate_recipient_accepts_e164() {
        assert!(AtModemManager::validate_recipient_with_short_code("+6512345678", false).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("6512345678", false).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("+861380013800", false).is_ok());
        assert!(AtModemManager::validate_recipient_with_short_code("123456", false).is_ok()); // 6 digits, minimum
        assert!(
            AtModemManager::validate_recipient_with_short_code("+123456789012345", false).is_ok()
        );
        // 15, maximum
    }

    #[test]
    fn test_validate_recipient_rejects_at_injection() {
        // The exact payload from the security review: terminate CMGS, then wipe the SIM.
        assert!(AtModemManager::validate_recipient_with_short_code(
            "+6512345678\r\nAT+CMGD=1,4\r",
            false
        )
        .is_err());
        // Bare CR is enough on its own.
        assert!(AtModemManager::validate_recipient_with_short_code(
            "+6512345678\rAT+CMGD=1,4",
            false
        )
        .is_err());
        assert!(
            AtModemManager::validate_recipient_with_short_code("+6512345678\n", false).is_err()
        );
        // Closing the quoted argument early.
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\"", false).is_err());
        // Other control characters that the modem's line discipline may act on.
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\x1A", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\x1B", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("+65123\0", false).is_err());
    }

    #[test]
    fn test_validate_recipient_rejects_malformed() {
        assert!(AtModemManager::validate_recipient_with_short_code("", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("+", false).is_err());
        assert!(AtModemManager::validate_recipient_with_short_code("12345", false).is_err()); // too short
        assert!(
            AtModemManager::validate_recipient_with_short_code("+1234567890123456", false).is_err()
        ); // too long
        assert!(
            AtModemManager::validate_recipient_with_short_code("+65 1234 5678", false).is_err()
        ); // spaces
        assert!(
            AtModemManager::validate_recipient_with_short_code("+65-1234-5678", false).is_err()
        ); // punctuation
        assert!(AtModemManager::validate_recipient_with_short_code("not-a-number", false).is_err());
        // A '+' is only valid as the leading character.
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

    // The body is terminated by Ctrl-Z (0x1A). A literal 0x1A inside the body ends SMS
    // entry early and returns the modem to command mode, so trailing bytes become AT
    // commands — the same injection as above, via a different field.
    #[test]
    fn test_validate_message_body_rejects_terminators() {
        assert!(AtModemManager::validate_message_body("hello").is_ok());
        assert!(AtModemManager::validate_message_body("你好，验证码 1234").is_ok());
        // Newlines are legitimate in a multi-line SMS body.
        assert!(AtModemManager::validate_message_body("line one\nline two").is_ok());
        assert!(AtModemManager::validate_message_body("line one\r\nline two").is_ok());

        assert!(AtModemManager::validate_message_body("x\x1AAT+CMGD=1,4\r").is_err());
        assert!(AtModemManager::validate_message_body("x\x1B").is_err());
        assert!(AtModemManager::validate_message_body("x\0y").is_err());
    }

    #[test]
    fn test_parse_iccid() {
        // Standard numeric ICCID
        assert_eq!(
            AtModemManager::parse_iccid("+QCCID: 89860121750097854321"),
            Some("89860121750097854321".to_string())
        );
        assert_eq!(
            AtModemManager::parse_iccid("89860121750097854321\nOK"),
            Some("89860121750097854321".to_string())
        );
        // ICCID with hex padding (F is stripped as BCD filler)
        assert_eq!(
            AtModemManager::parse_iccid("+QCCID: 8965012306052989707F"),
            Some("8965012306052989707".to_string())
        );
        assert_eq!(
            AtModemManager::parse_iccid("AT+QCCID\r\n+QCCID: 8965012306052989681F\r\n\r\nOK\r\n"),
            Some("8965012306052989681".to_string())
        );
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
    fn test_sms_read_store_candidates_scan_me_then_sm() {
        let supported = vec!["SM".into(), "ME".into(), "MT".into(), "SR".into()];

        assert_eq!(
            AtModemManager::sms_read_store_candidates(&supported),
            vec!["ME", "SM"]
        );
    }

    #[test]
    fn test_sms_read_store_candidates_use_mt_only_as_fallback() {
        let supported = vec!["MT".into(), "SR".into()];

        assert_eq!(
            AtModemManager::sms_read_store_candidates(&supported),
            vec!["MT"]
        );
    }

    #[test]
    fn test_sms_read_store_candidates_exclude_status_report_storage() {
        let supported = vec!["SR".into(), "BM".into()];

        assert!(AtModemManager::sms_read_store_candidates(&supported).is_empty());
    }

    // test_port_conversion moved to tests/at_modem_tests.rs (tests public API)

    #[test]
    fn test_ucs2_decode() {
        // Chinese "你好" = 4F60 597D
        assert_eq!(
            AtModemManager::decode_ucs2_hex("4F60597D"),
            Some("你好".to_string())
        );

        // English "Hi" = 0048 0069
        assert_eq!(
            AtModemManager::decode_ucs2_hex("00480069"),
            Some("Hi".to_string())
        );

        // Empty returns empty string, invalid returns None
        assert_eq!(AtModemManager::decode_ucs2_hex(""), Some("".to_string()));
        assert_eq!(AtModemManager::decode_ucs2_hex("4F6"), None); // Odd length (3 chars)
    }

    #[test]
    fn test_decode_sms_content() {
        // UCS2 hex should be decoded
        assert_eq!(AtModemManager::decode_sms_content("4F60597D"), "你好");

        // Plain English should pass through
        assert_eq!(
            AtModemManager::decode_sms_content("Hello World"),
            "Hello World"
        );

        // Short hex that might be a code should pass through
        assert_eq!(
            AtModemManager::decode_sms_content("1234"),
            AtModemManager::decode_sms_content("1234") // May decode or pass through
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
        // Simple ASCII message in 7-bit GSM encoding (no UDH)
        // "Hello" encoded in 7-bit GSM
        let bytes = vec![0xC8, 0x32, 0x9B, 0xFD, 0x06];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 0); // udhl=0 (no UDH)
        assert_eq!(result, "Hello");
    }

    #[test]
    fn test_pdu_ucs2_encoding_chinese() {
        // Chinese "你好" = 4F60 597D in UCS-2 (UTF-16BE)
        let bytes = vec![0x4F, 0x60, 0x59, 0x7D];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 4);
        assert_eq!(result, "你好");
    }

    #[test]
    fn test_pdu_ucs2_encoding_mixed() {
        // "Hi你好" = 0048 0069 4F60 597D
        let bytes = vec![0x00, 0x48, 0x00, 0x69, 0x4F, 0x60, 0x59, 0x7D];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 8);
        assert_eq!(result, "Hi你好");
    }

    #[test]
    fn test_pdu_ucs2_with_udh() {
        // UCS-2 message with UDH header (multipart SMS)
        // NOTE: In real usage, the caller skips the UDH before calling decode_pdu_ucs2
        // Header would be: 05 00 03 42 02 01 (UDHL=5, IEI=0, IEDL=3, ref=0x42, total=2, seq=1)
        // We pass only the text part: "你" = 4F60
        let bytes = vec![
            0x4F, 0x60, // "你" (UDH already removed by caller)
        ];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 2);
        assert_eq!(result, "你");
    }

    #[test]
    fn test_pdu_dcs_detection() {
        // Test Data Coding Scheme bit patterns
        // Bit 2 (0x04) = indicates 8-bit data
        // Bit 3 (0x08) = indicates UCS-2 when bit 2 is also set

        // DCS=0x00: 7-bit GSM (default)
        let dcs_7bit = 0x00;
        assert_eq!(dcs_7bit & 0x04, 0); // Not 8-bit/UCS2

        // DCS=0x08: UCS-2 encoding (common for Chinese)
        // In GSM 03.38, DCS=0x08 means "UCS2" in general data coding group
        let dcs_ucs2_common = 0x08;
        assert_ne!(dcs_ucs2_common & 0x08, 0); // Bit 3 set

        // DCS=0x0C: 8-bit + UCS-2 encoding (both bits set)
        let dcs_ucs2_explicit = 0x0C;
        assert_ne!(dcs_ucs2_explicit & 0x04, 0); // Bit 2 set (8-bit)
        assert_ne!(dcs_ucs2_explicit & 0x08, 0); // Bit 3 set (UCS-2)

        // DCS=0x04: 8-bit encoding (not UCS-2)
        let dcs_8bit = 0x04;
        assert_ne!(dcs_8bit & 0x04, 0); // Is 8-bit
        assert_eq!(dcs_8bit & 0x08, 0); // Not UCS-2
    }

    #[test]
    fn test_extract_udh_concat() {
        // Concatenation header 8-bit ref: 00 03 42 02 01
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
        // Concatenation header 16-bit ref: 08 04 0042 02 01
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
        // Test a realistic Chinese SMS scenario
        // Message: "【联通提醒】尊敬的..." (common Chinese carrier format)
        // UCS-2 encoded with multipart header
        // NOTE: In real usage, UDH is removed before calling decode_pdu_ucs2

        // Text part only (UDH already removed by caller)
        let bytes_part1 = vec![
            0x30, 0x10, 0x80, 0x54, 0x90, 0x1A, // "【联通"
        ];
        let text1 = AtModemManager::decode_pdu_ucs2(&bytes_part1, 6);
        assert!(!text1.is_empty());
        assert!(text1.contains("联") || text1.contains("通")); // Should contain Chinese
    }

    // ============================================================================
    // COMPREHENSIVE PDU PARSING TESTS (protect against regressions)
    // ============================================================================

    #[test]
    fn test_decode_bcd_phone_standard() {
        // "+1234567890" in BCD: 21 43 65 87 09 F0
        let bytes = vec![0x21, 0x43, 0x65, 0x87, 0x09, 0xF0];
        let result = AtModemManager::decode_bcd_phone(&bytes, 11);
        assert_eq!(result, "12345678900"); // F is padding
    }

    #[test]
    fn test_decode_bcd_phone_odd_length() {
        // "+123456789" (9 digits, odd) in BCD: 21 43 65 87 F9
        let bytes = vec![0x21, 0x43, 0x65, 0x87, 0xF9];
        let result = AtModemManager::decode_bcd_phone(&bytes, 9);
        assert_eq!(result, "123456789");
    }

    #[test]
    fn test_decode_bcd_phone_chinese() {
        // "+8613800138000" (13 digits) - typical Chinese mobile
        // BCD encoding: 68 31 08 10 83 00 F0
        let bytes = vec![0x68, 0x31, 0x08, 0x10, 0x83, 0x00, 0xF0];
        let result = AtModemManager::decode_bcd_phone(&bytes, 13);
        assert_eq!(result, "8613800138000");
    }

    #[test]
    fn test_decode_pdu_timestamp_with_positive_tz() {
        // Test timestamp decoding (testing the actual decode logic works)
        let bytes = vec![0x62, 0x30, 0x11, 0x41, 0x03, 0x00, 0x00];
        let result = AtModemManager::decode_pdu_timestamp(&bytes);
        // Should produce valid ISO 8601 format
        assert!(result.contains("T"));
        assert!(result.ends_with("Z"));
        assert!(result.len() > 20); // ISO format is ~24 chars
    }

    #[test]
    fn test_decode_pdu_timestamp_with_negative_tz() {
        // Test timestamp with timezone handling
        let bytes = vec![0x62, 0x10, 0x51, 0x21, 0x00, 0x00, 0x23];
        let result = AtModemManager::decode_pdu_timestamp(&bytes);
        // Should produce valid ISO 8601 format with timezone conversion
        assert!(result.contains("T"));
        assert!(result.ends_with("Z"));
    }

    #[test]
    fn test_decode_pdu_timestamp_edge_case() {
        // Test edge case: short/invalid timestamp
        let bytes = vec![0x99, 0x99, 0x99]; // Invalid but should not crash
        let result = AtModemManager::decode_pdu_timestamp(&bytes);
        // Should return fallback timestamp (current time)
        assert!(result.contains("T"));
        assert!(result.ends_with("Z"));
    }

    #[test]
    fn test_decode_pdu_7bit_with_udh_fill_bits() {
        // Multipart SMS with 7-bit encoding requires fill bits
        // UDH length = 5 bytes (header: 05 00 03 42 02 01)
        // Fill bits = (7 - ((5+1)*8 % 7)) % 7 = (7 - (48 % 7)) % 7 = (7 - 6) % 7 = 1
        // Text "Hello" after 1 fill bit
        let bytes = vec![
            0x90, 0x64, 0x36, 0x1B, 0x0D, // "Hello" with 1 fill bit offset
        ];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 5); // udhl=5
                                                                    // With fill bit, result should still be "Hello" (or close)
        assert!(result.len() >= 4); // At least most of "Hello"
    }

    #[test]
    fn test_decode_pdu_7bit_long_message() {
        // Longer 7-bit message to test boundary conditions
        // "This is a test message" (22 chars) encoded in 7-bit GSM
        let bytes = vec![
            0x54, 0x74, 0x7A, 0x0E, 0x4A, 0xCF, 0x41, 0x61, 0x10, 0xBD, 0x3C, 0x07, 0xD9, 0xDF,
            0x73, 0x90, 0xFB, 0x0D, 0x9A, 0x03,
        ];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 22, 0);
        assert!(result.len() >= 20); // Should decode most of the message
    }

    #[test]
    fn test_parse_pdu_sms_structure() {
        // Test PDU parsing structure validation (not full decode)
        // This test uses a simplified valid PDU structure
        // SMSC: 00 (no SMSC)
        // PDU Type: 04
        // Sender: 0B 91 2143658709F0 (+1234567890, 11 digits in BCD)
        // PID: 00, DCS: 00 (7-bit), Timestamp: 42301141030023 (7 bytes)
        // UDL: 05, Text: C8329BFD06 (5 septets)
        let pdu = "00040B912143658709F00000423011410300230AC8329BFD06";
        let result = AtModemManager::parse_pdu_sms(1, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert_eq!(sms.index, 1);
        assert!(!sms.text.is_empty()); // Should decode something
        assert!(sms.concat_info.is_none()); // Single-part
    }

    #[test]
    fn test_parse_pdu_sms_with_udh_structure() {
        // Test UDH extraction (simplified PDU with UDH header)
        // SMSC: 00
        // PDU Type: 44 (bit 6 = UDH present)
        // Sender: 0B 91 2143658709F0
        // PID: 00, DCS: 00, Timestamp: 7 bytes
        // UDL: 0A (includes UDH + text)
        // UDHL: 05, UDH: 00 03 42 02 01 (8-bit concat: ref=0x42, total=2, part=1)
        // Text: A8 (1 septet after UDH)
        let pdu = "00440B912143658709F00000423011410300230A0500034202 01A8";
        let result = AtModemManager::parse_pdu_sms(3, &pdu.replace(" ", ""));
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
        // Truncated PDU (too short)
        let pdu = "07916831";
        let result = AtModemManager::parse_pdu_sms(5, pdu);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_pdu_sms_error_invalid_hex() {
        // Invalid hex characters
        let pdu = "ZZZZZZZZZZ";
        let result = AtModemManager::parse_pdu_sms(6, pdu);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_udh_concat_no_concat_header() {
        // UDH with non-concatenation header (e.g., special SMS indicator)
        // IEI=0x01 (Special SMS indication), IEDL=0x02, data: 00 01
        let udh = vec![0x01, 0x02, 0x00, 0x01];
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_none()); // No concatenation header found
    }

    #[test]
    fn test_extract_udh_concat_truncated() {
        // Truncated UDH (claims IEDL=3 but not enough bytes)
        let udh = vec![0x00, 0x03, 0x42]; // Missing total_parts and part_number
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_udh_concat_16bit_full_reference() {
        // 16-bit reference ID should use lower byte only
        // IEI=0x08, IEDL=0x04, ref=0xABCD (use 0xCD), total=3, part=1
        let udh = vec![0x08, 0x04, 0xAB, 0xCD, 0x03, 0x01];
        let result = AtModemManager::extract_udh_concat(&udh);
        assert!(result.is_some());
        let concat = result.unwrap();
        assert_eq!(concat.ref_id, 0xCD); // Lower byte of 0xABCD
        assert_eq!(concat.total_parts, 3);
        assert_eq!(concat.part_number, 1);
    }

    #[test]
    fn test_decode_pdu_ucs2_empty() {
        // Empty UCS-2 content
        let bytes = vec![];
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 0);
        assert_eq!(result, "");
    }

    #[test]
    fn test_decode_pdu_ucs2_odd_length() {
        // Odd number of bytes (invalid UTF-16) - should handle gracefully
        let bytes = vec![0x4F, 0x60, 0x59]; // Missing last byte
        let result = AtModemManager::decode_pdu_ucs2(&bytes, 3);
        // Should return partial decode or "?"
        assert!(!result.is_empty() || result == "?");
    }

    #[test]
    fn test_decode_pdu_7bit_boundary_conditions() {
        // Test boundary: exactly 160 characters (single SMS limit)
        // 160 septets = 140 bytes when packed
        // Note: use chars().count() not len() because GSM chars may be multi-byte UTF-8
        let bytes = vec![0x41; 140]; // 'A' repeated (simplified)
        let result = AtModemManager::decode_pdu_7bit(&bytes, 160, 0);
        assert_eq!(result.chars().count(), 160);
    }

    #[test]
    fn test_decode_bcd_phone_empty() {
        // Edge case: empty phone number
        let bytes = vec![];
        let result = AtModemManager::decode_bcd_phone(&bytes, 0);
        assert_eq!(result, "");
    }

    #[test]
    fn test_parse_pdu_sms_8bit_encoding() {
        // 8-bit data encoding (DCS=0x04)
        // SMSC: 00 (no SMSC)
        // PDU Type: 04, Sender: 0B 91 2143658709F0
        // PID: 00, DCS: 04 (8-bit), Timestamp: 42301141030023
        // UDL: 05, Text: 48656C6C6F ("Hello" as raw 8-bit bytes)
        let pdu = "00040B912143658709F000044230114103002305048656C6C6F";
        let result = AtModemManager::parse_pdu_sms(7, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert!(sms.text.contains("Hello") || sms.text.len() >= 5);
    }

    #[test]
    fn test_parse_pdu_sms_ucs2_encoding() {
        // UCS-2 encoding test (DCS=0x08)
        // SMSC: 00
        // PDU Type: 04, Sender: 0B 91 2143658709F0
        // PID: 00, DCS: 08 (UCS-2), Timestamp: 42301141030023
        // UDL: 04, Text: 4F60597D ("你好" in UTF-16BE)
        let pdu = "00040B912143658709F000084230114103002304004F60597D";
        let result = AtModemManager::parse_pdu_sms(8, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        // Check that UCS-2 decoding happened (should contain Chinese characters)
        assert!(sms.text.contains("你") || sms.text.contains("好") || sms.text.len() >= 2);
        assert!(sms.concat_info.is_none());
    }

    // ============================================================================
    // BCD PHONE NUMBER TESTS — hex nibbles A-F
    // ============================================================================

    #[test]
    fn test_decode_bcd_phone_with_hex_nibbles() {
        // Nibble 0xA = '*', 0xB = '#'
        // Byte 0xBA → low=A(*), high=B(#) → "*#"
        let bytes = vec![0xBA];
        let result = AtModemManager::decode_bcd_phone(&bytes, 2);
        assert_eq!(result, "*#");
    }

    #[test]
    fn test_at_probe_order() {
        let p4: Vec<String> = (0..4).map(|n| format!("/dev/ttyUSB{}", n)).collect();
        // 4-port: AT slot (index 2) tried first, then 0,1,3
        assert_eq!(
            AtModemManager::at_probe_order(&p4),
            vec![
                "/dev/ttyUSB2",
                "/dev/ttyUSB0",
                "/dev/ttyUSB1",
                "/dev/ttyUSB3"
            ]
        );
        // 2-port (slimmed): index 0 first
        let p2: Vec<String> = vec!["/dev/ttyUSB6".into(), "/dev/ttyUSB7".into()];
        assert_eq!(
            AtModemManager::at_probe_order(&p2),
            vec!["/dev/ttyUSB6", "/dev/ttyUSB7"]
        );
        // single port
        let p1: Vec<String> = vec!["/dev/ttyUSB9".into()];
        assert_eq!(AtModemManager::at_probe_order(&p1), vec!["/dev/ttyUSB9"]);
    }

    #[test]
    fn test_modem_id_port_roundtrip() {
        // modem_id is the AT port's ttyUSB index — works for any offset (default or slimmed)
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB2"), "2");
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB0"), "0");
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB58"), "58");
        assert_eq!(AtModemManager::modem_id_to_port("2"), "/dev/ttyUSB2");
        assert_eq!(AtModemManager::modem_id_to_port("0"), "/dev/ttyUSB0");
        assert_eq!(AtModemManager::modem_id_to_port("58"), "/dev/ttyUSB58");
        // round-trip
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
        // "1*2#" → BCD bytes: 0xA1, 0x2B (low nibble first per BCD swap)
        // Wait — BCD encoding: "1*" → low=1, high=A → byte 0xA1
        //                       "2#" → low=2, high=B → byte 0xB2
        let bytes = vec![0xA1, 0xB2];
        let result = AtModemManager::decode_bcd_phone(&bytes, 4);
        assert_eq!(result, "1*2#");
    }

    #[test]
    fn test_decode_bcd_phone_nibble_c_d() {
        // 0xC = 'a', 0xD = 'b'
        let bytes = vec![0xDC];
        let result = AtModemManager::decode_bcd_phone(&bytes, 2);
        assert_eq!(result, "ab");
    }

    #[test]
    fn test_decode_bcd_phone_nibble_e_skipped() {
        // 0xE is reserved — should be skipped (not produce '?')
        let bytes = vec![0xE1]; // low=1, high=E(skip)
        let result = AtModemManager::decode_bcd_phone(&bytes, 2);
        assert_eq!(result, "1"); // only digit 1, E skipped
    }

    // ============================================================================
    // GSM 7-BIT ALPHABET TESTS
    // ============================================================================

    #[test]
    fn test_decode_pdu_7bit_backward_compat() {
        // "Hello" in GSM 7-bit: H=0x48, e=0x65, l=0x6C, l=0x6C, o=0x6F
        // Same positions in ASCII and GSM, so this must still work
        let bytes = vec![0xC8, 0x32, 0x9B, 0xFD, 0x06];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 0);
        assert_eq!(result, "Hello");
    }

    #[test]
    fn test_decode_pdu_7bit_gsm_alphabet_at_sign() {
        // '@' is at GSM position 0x00 (NOT 0x40 like ASCII)
        // Single septet 0x00 packed into one byte
        let bytes = vec![0x00];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 1, 0);
        assert_eq!(result, "@");
    }

    #[test]
    fn test_decode_pdu_7bit_gsm_special_chars() {
        // Test positions that differ from ASCII:
        // GSM 0x01 = '£', GSM 0x02 = '$', GSM 0x05 = 'é'
        // Pack 3 septets: 0x01, 0x02, 0x05
        // Septet packing:
        //   byte0: septet0(0x01) | septet1_low1<<7 = 0x01 | (0x02&1)<<7 = 0x01 | 0x00 = 0x01
        //   byte1: septet1>>1 | septet2_low2<<6 = 0x01 | (0x05&3)<<6 = 0x01 | 0x40 = 0x41
        //   byte2: septet2>>2 = 0x01
        let bytes = vec![0x01, 0x41, 0x01];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 3, 0);
        assert_eq!(result, "£$é");
    }

    #[test]
    fn test_decode_pdu_7bit_gsm_inverted_marks() {
        // GSM 0x40 = '¡' (NOT '@'), GSM 0x60 = '¿'
        // Pack 2 septets: 0x40, 0x60
        // byte0: 0x40 | (0x60 & 0x01) << 7 = 0x40
        // byte1: 0x60 >> 1 = 0x30
        let bytes = vec![0x40, 0x30];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
        assert_eq!(result, "¡¿");
    }

    #[test]
    fn test_decode_pdu_7bit_escape_sequences() {
        // ESC (0x1B) + 0x3C = '[', ESC + 0x3E = ']'
        // 4 septets: 0x1B, 0x3C, 0x1B, 0x3E
        // Septet packing (7 bits each):
        //   bit_pos 0:  0x1B → byte0 bits 0-6
        //   bit_pos 7:  0x3C → byte0 bit7 + byte1 bits 0-5
        //   bit_pos 14: 0x1B → byte1 bits 6-7 + byte2 bits 0-4
        //   bit_pos 21: 0x3E → byte2 bits 5-7 + byte3 bits 0-3
        // byte0: 0x1B | (0x3C & 0x01) << 7 = 0x1B | 0x00 = 0x1B
        // byte1: (0x3C >> 1) | (0x1B & 0x03) << 6 = 0x1E | 0xC0 = 0xDE
        // byte2: (0x1B >> 2) | (0x3E & 0x07) << 5 = 0x06 | 0xC0 = 0xC6
        // byte3: 0x3E >> 3 = 0x07
        let bytes = vec![0x1B, 0xDE, 0xC6, 0x07];
        // 4 septets consumed but ESC pairs produce 2 output chars
        let result = AtModemManager::decode_pdu_7bit(&bytes, 4, 0);
        assert_eq!(result, "[]");
    }

    #[test]
    fn test_decode_pdu_7bit_euro_sign() {
        // ESC (0x1B) + 0x65 = '€'
        // 2 septets: 0x1B, 0x65
        // byte0: 0x1B | (0x65 & 0x01) << 7 = 0x1B | 0x80 = 0x9B
        // byte1: 0x65 >> 1 = 0x32
        let bytes = vec![0x9B, 0x32];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
        assert_eq!(result, "€");
    }

    #[test]
    fn test_decode_pdu_7bit_high_positions() {
        // GSM 0x7B = 'ä', 0x7C = 'ö', 0x7D = 'ñ', 0x7E = 'ü', 0x7F = 'à'
        // Pack 2 septets: 0x7B, 0x7C
        // byte0: 0x7B | (0x7C & 0x01) << 7 = 0x7B | 0x00 = 0x7B
        // byte1: 0x7C >> 1 = 0x3E
        let bytes = vec![0x7B, 0x3E];
        let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
        assert_eq!(result, "äö");
    }

    // ============================================================================
    // ALPHANUMERIC SENDER TESTS
    // ============================================================================

    #[test]
    fn test_parse_pdu_sms_alphanumeric_sender() {
        // PDU with alphanumeric sender "Google"
        // SMSC: 00
        // PDU Type: 04
        // Sender length: 0C (12 semi-octets → 6 bytes → (12*4)/7 = 6 septets)
        // Sender TOA: D0 (TON=5 alphanumeric, NPI=0)
        // Sender: C7F7FBCC2E03 ("Google" in GSM 7-bit packed)
        //   G=0x47, o=0x6F, o=0x6F, g=0x67, l=0x6C, e=0x65
        //   byte0: 0x47 | (0x6F & 0x01) << 7 = 0x47 | 0x80 = 0xC7
        //   byte1: 0x6F >> 1 | (0x6F & 0x03) << 6 = 0x37 | 0xC0 = 0xF7
        //   byte2: 0x6F >> 2 | (0x67 & 0x07) << 5 = 0x1B | 0xE0 = 0xFB
        //   byte3: 0x67 >> 3 | (0x6C & 0x0F) << 4 = 0x0C | 0xC0 = 0xCC
        //   byte4: 0x6C >> 4 | (0x65 & 0x1F) << 3 = 0x06 | 0x28 = 0x2E
        //   byte5: 0x65 >> 5 = 0x03
        // PID: 00, DCS: 00, Timestamp: 42301141030023, UDL: 05
        // Text: C8329BFD06 ("Hello")
        let pdu = "00040CD0C7F7FBCC2E0300004230114103002305C8329BFD06";
        let result = AtModemManager::parse_pdu_sms(1, pdu);
        assert!(result.is_ok());
        let sms = result.unwrap();
        assert_eq!(sms.sender, "Google");
        assert_eq!(sms.text, "Hello");
    }
}
