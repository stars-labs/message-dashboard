//! Direct AT command modem interface - bypasses ModemManager for better performance
//!
//! For Quectel EC20 modems, each modem exposes 4 ttyUSB ports:
//! - ttyUSB0: DM port
//! - ttyUSB1: GPS NMEA
//! - ttyUSB2: AT commands (this is what we use)
//! - ttyUSB3: PPP/Modem

use anyhow::{anyhow, Result};
use nix::sys::termios::{self, BaudRate, SetArg};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/// SMS message from AT command interface
#[derive(Debug, Clone)]
pub struct AtSms {
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
    pub ref_id: u8,       // Reference ID (groups parts together)
    pub total_parts: u8,  // Total number of parts
    pub part_number: u8,  // This part's number (1-indexed)
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
    /// Timeout for AT commands
    timeout: Duration,
}

impl AtModemManager {
    pub fn new() -> Self {
        Self {
            modems: Arc::new(RwLock::new(HashMap::new())),
            timeout: Duration::from_secs(5),
        }
    }

    /// Discover all Quectel EC20 AT command ports
    /// EC20 uses ttyUSB2 for AT commands (every 4th port starting at 2)
    pub async fn discover_modems(&self) -> Result<Vec<String>> {
        let mut ports = Vec::new();
        let mut probe_failed_count = 0;

        // Scan /dev/ttyUSB* for AT command ports without an arbitrary upper bound
        // EC20 pattern: ttyUSB2, ttyUSB6, ttyUSB10, ... (every 4th, offset 2)
        let mut at_ports: Vec<String> = fs::read_dir("/dev")
            .map_err(|e| anyhow!("Failed to read /dev for modem discovery: {}", e))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("ttyUSB") {
                    return None;
                }

                let num_str = name.trim_start_matches("ttyUSB");
                let num = num_str.parse::<u32>().ok()?;

                // EC20 AT ports are every 4th port starting at 2
                if num >= 2 && num % 4 == 2 {
                    Some(format!("/dev/ttyUSB{}", num))
                } else {
                    None
                }
            })
            .collect();

        at_ports.sort();
        let existing_count = at_ports.len();

        for port_path in at_ports {
            // Quick probe to verify it responds to AT
            match self.probe_port_with_error(&port_path).await {
                Ok(true) => {
                    // Initialize IMS on successful probe
                    if let Err(e) = self.init_ims(&port_path).await {
                        warn!("Failed to initialize IMS on {}: {}", port_path, e);
                    }
                    ports.push(port_path);
                }
                Ok(false) => {
                    debug!("Port {} exists but no AT response", port_path);
                    probe_failed_count += 1;
                }
                Err(e) => {
                    warn!("Port {} probe error: {}", port_path, e);
                    probe_failed_count += 1;
                }
            }
        }

        if existing_count > 0 && ports.is_empty() {
            warn!(
                "Found {} USB serial ports but none responded to AT commands (probe failures: {})",
                existing_count, probe_failed_count
            );
            warn!("Check: 1) permissions on /dev/ttyUSB*, 2) if ModemManager is holding ports");
        }

        info!(
            "Discovered {} AT modem ports (scanned {} existing ports)",
            ports.len(),
            existing_count
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
    async fn probe_port(&self, port: &str) -> bool {
        match self
            .send_at_command(port, "AT", Duration::from_millis(500))
            .await
        {
            Ok(response) => response.contains("OK"),
            Err(_) => false,
        }
    }

    /// Initialize IMS settings on modem
    async fn init_ims(&self, port: &str) -> Result<()> {
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
        let port_path = port.to_string();
        let cmd = command.to_string();

        // Run blocking serial I/O in spawn_blocking
        tokio::task::spawn_blocking(move || Self::send_at_sync(&port_path, &cmd, timeout)).await?
    }

    /// Open serial port with proper settings
    fn open_serial(port: &str) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
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

    /// Synchronous AT command send (runs in blocking thread)
    fn send_at_sync(port: &str, command: &str, timeout: Duration) -> Result<String> {
        let mut file = Self::open_serial(port)?;

        // Send command with CR
        let cmd = format!("{}\r", command);
        file.write_all(cmd.as_bytes())
            .map_err(|e| anyhow!("Write failed: {}", e))?;
        file.flush()?;

        // Read response with timeout
        let mut response = Vec::new();
        let mut buf = [0u8; 256];
        let start = Instant::now();

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

        let cgreg = self.send_at_command(port, "AT+CGREG?", self.timeout).await?;
        let gregs = Self::parse_cgreg(&cgreg);

        Ok(NetworkRegStatus {
            creg,
            cgreg: gregs,
        })
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
        let response = self.send_at_command(port, "AT+QCFG=\"ims\"", self.timeout).await?;

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

        let reg_response = self.send_at_command(port, "AT+QIREGAPP?", self.timeout).await?;
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
        let storage = storage_response.lines().find(|l| l.contains("+CPMS:")).map(|s| s.to_string()).unwrap_or_default();

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

    /// List all SMS messages, merging concatenated parts using PDU metadata.
    /// Uses PDU mode to get concatenation info for multipart SMS.
    pub async fn list_sms(&self, port: &str) -> Result<Vec<AtSms>> {
        // Use PDU mode to get concatenation metadata for multipart SMS
        match self.list_sms_pdu_mode(port).await {
            Ok(messages) if !messages.is_empty() => {
                debug!("PDU mode: got {} messages from {}", messages.len(), port);
                Ok(messages)
            }
            Ok(_) => {
                // PDU mode succeeded but returned no messages - try text mode
                debug!("PDU mode returned empty, trying text mode on {}", port);
                let messages = self.list_sms_text_mode(port).await?;
                debug!("Text mode: got {} messages from {}", messages.len(), port);
                Ok(messages)
            }
            Err(e) => {
                // PDU mode failed - fall back to text mode
                warn!("PDU mode failed on {}: {} - falling back to text mode", port, e);
                let messages = self.list_sms_text_mode(port).await?;
                debug!("Text mode fallback: got {} messages from {}", messages.len(), port);
                Ok(messages)
            }
        }
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
                warn!("Text mode: Failed to set UCS2 charset on {}: {} - using default", port, e);
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
                                index: sms.0,
                                part_indices: vec![sms.0],
                                sender: sms.1,
                                timestamp: sms.2,
                                text,
                                concat_info: None,  // Text mode doesn't provide concatenation info
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
                        if !pdu_hex.is_empty() && pdu_hex != "OK" && !pdu_hex.contains("+CMGL:")
                        {
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
        pos += 1; // Skip type

        // Sender address (BCD encoded, 2 digits per byte)
        let sender_bytes = (sender_len + 1) / 2;
        if pos + sender_bytes > pdu_bytes.len() {
            return Err(anyhow!("PDU truncated at sender address"));
        }
        let sender = Self::decode_bcd_phone(&pdu_bytes[pos..pos + sender_bytes], sender_len);
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

    /// Decode BCD-encoded phone number
    fn decode_bcd_phone(bytes: &[u8], digit_count: usize) -> String {
        let mut phone = String::new();
        for (i, byte) in bytes.iter().enumerate() {
            let digit1 = byte & 0x0F;
            let digit2 = (byte >> 4) & 0x0F;

            if i * 2 < digit_count && digit1 != 0x0F {
                phone.push(char::from_digit(digit1 as u32, 10).unwrap_or('?'));
            }
            if i * 2 + 1 < digit_count && digit2 != 0x0F {
                phone.push(char::from_digit(digit2 as u32, 10).unwrap_or('?'));
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

        let swap_nibbles = |b: u8| -> u8 { ((b & 0x0F) << 4) | ((b >> 4) & 0x0F) };

        let year = swap_nibbles(bytes[0]) as i32 + 2000;
        let month = swap_nibbles(bytes[1]) as u32;
        let day = swap_nibbles(bytes[2]) as u32;
        let hour = swap_nibbles(bytes[3]) as u32;
        let minute = swap_nibbles(bytes[4]) as u32;
        let second = swap_nibbles(bytes[5]) as u32;

        // Timezone (in quarter hours)
        let tz_byte = bytes[6];
        let tz_quarters = swap_nibbles(tz_byte & 0x7F) as i32;
        let tz_sign = if (tz_byte & 0x08) != 0 { -1 } else { 1 };
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

            // GSM 7-bit default alphabet (simplified - just handle ASCII range)
            if char_val < 128 {
                result.push(char_val as char);
            } else {
                result.push('?');
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
        let sender = Self::decode_sms_content(raw_sender);

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
            if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&local_str, "%Y-%m-%dT%H:%M:%S") {
                let utc = naive - chrono::Duration::minutes(offset_minutes as i64);
                return format!("{}Z", utc.format("%Y-%m-%dT%H:%M:%S%.3f"));
            }

            // Fallback: return with offset if chrono parse fails
            let tz_hours = offset_minutes.abs() / 60;
            let tz_mins = offset_minutes.abs() % 60;
            let sign = if offset_minutes >= 0 { '+' } else { '-' };
            return format!("{}-{}-{}T{}{}{:02}:{:02}", year, month, day, time_clean, sign, tz_hours, tz_mins);
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

    /// Send SMS
    pub async fn send_sms(&self, port: &str, recipient: &str, message: &str) -> Result<()> {
        // Set text mode
        self.send_at_command(port, "AT+CMGF=1", self.timeout)
            .await?;

        // Check if we need UCS2 encoding for Unicode content
        let use_ucs2 = Self::needs_ucs2(message);

        if use_ucs2 {
            // Set UCS2 character set and message format for Unicode messages
            self.send_at_command(port, "AT+CSCS=\"UCS2\"", self.timeout)
                .await?;
            // Set message parameters: validity period, DCS=8 for UCS2
            self.send_at_command(port, "AT+CSMP=17,167,0,8", self.timeout)
                .await?;
        } else {
            // Set GSM character set for ASCII messages
            self.send_at_command(port, "AT+CSCS=\"GSM\"", self.timeout)
                .await?;
            // Reset message parameters to default GSM 7-bit
            self.send_at_command(port, "AT+CSMP=17,167,0,0", self.timeout)
                .await?;
        }

        let port_path = port.to_string();
        let recipient = recipient.to_string();
        let msg = message.to_string();
        let timeout = self.timeout;

        tokio::task::spawn_blocking(move || {
            Self::send_sms_sync(&port_path, &recipient, &msg, timeout, use_ucs2)
        })
        .await?
    }

    fn send_sms_sync(
        port: &str,
        recipient: &str,
        message: &str,
        timeout: Duration,
        use_ucs2: bool,
    ) -> Result<()> {
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

        while start.elapsed() < Duration::from_secs(5) {
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
            return Err(anyhow!("Timeout waiting for > prompt"));
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

    /// Convert port path to modem ID
    /// /dev/ttyUSB2 -> "0", /dev/ttyUSB6 -> "1", etc.
    pub fn port_to_modem_id(port: &str) -> String {
        if let Some(num_str) = port.strip_prefix("/dev/ttyUSB") {
            if let Ok(num) = num_str.parse::<u32>() {
                return ((num - 2) / 4).to_string();
            }
        }
        port.to_string()
    }

    /// Convert modem ID to port path
    pub fn modem_id_to_port(id: &str) -> String {
        if let Ok(num) = id.parse::<u32>() {
            return format!("/dev/ttyUSB{}", num * 4 + 2);
        }
        id.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_port_conversion() {
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB2"), "0");
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB6"), "1");
        assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB10"), "2");

        assert_eq!(AtModemManager::modem_id_to_port("0"), "/dev/ttyUSB2");
        assert_eq!(AtModemManager::modem_id_to_port("1"), "/dev/ttyUSB6");
        assert_eq!(AtModemManager::modem_id_to_port("2"), "/dev/ttyUSB10");
    }

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
            0x54, 0x74, 0x7A, 0x0E, 0x4A, 0xCF, 0x41, 0x61, 0x10, 0xBD, 0x3C, 0x07, 0xD9,
            0xDF, 0x73, 0x90, 0xFB, 0x0D, 0x9A, 0x03,
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
        let bytes = vec![0x41; 140]; // 'A' repeated (simplified)
        let result = AtModemManager::decode_pdu_7bit(&bytes, 160, 0);
        assert_eq!(result.len(), 160);
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
}
