use super::{read_chunk, set_control_char, AtModemManager};
use anyhow::{anyhow, Result};
use nix::sys::termios::{self, BaudRate, SetArg};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

impl AtModemManager {
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

    pub(super) async fn send_at_command(
        &self,
        port: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<String> {
        let port_lock = self.port_lock(port).await;
        let _guard = port_lock.lock().await;
        Self::send_at_command_unlocked(port, command, timeout).await
    }

    pub(super) async fn send_at_command_unlocked(
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

    pub(super) fn require_recovered_at_channel(response: &str) -> Result<()> {
        if response.contains("OK") {
            Ok(())
        } else {
            Err(anyhow!(
                "Modem did not respond to AT after SMS input recovery: {}",
                response.trim()
            ))
        }
    }

    pub(super) async fn recover_sms_input_unlocked(&self, port: &str) -> Result<String> {
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
}
