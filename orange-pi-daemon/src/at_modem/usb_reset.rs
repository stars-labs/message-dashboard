use super::AtModemManager;
use anyhow::{anyhow, Result};
use std::fs::{self, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{debug, info, warn};

// USBDEVFS_RESET = _IO('U', 20)
nix::ioctl_none!(usbdevfs_reset, b'U', 20);

impl AtModemManager {
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

    pub(super) fn usbfs_node_path(busnum: u8, devnum: u8) -> String {
        format!("/dev/bus/usb/{busnum:03}/{devnum:03}")
    }

    fn read_sysfs_u8(path: &Path) -> Result<u8> {
        let raw = fs::read_to_string(path)
            .map_err(|e| anyhow!("read {} failed: {}", path.display(), e))?;
        raw.trim()
            .parse::<u8>()
            .map_err(|e| anyhow!("parse {} ('{}') failed: {}", path.display(), raw.trim(), e))
    }
}
