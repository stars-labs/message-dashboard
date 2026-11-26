use super::{AtModemManager, VoicePorts};
use anyhow::{anyhow, Result};
use std::collections::BTreeMap;
use std::fs;
use std::time::Duration;
use tracing::{debug, info, warn};

impl AtModemManager {
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

    /// The USB interface a `/dev/ttyUSBN` port is bound to, e.g. `2` for `:1.2`.
    pub fn usb_interface_for_port_in(root: &std::path::Path, port: &str) -> Option<u8> {
        let name = port.trim_start_matches("/dev/");
        let link = root.join(format!("sys/class/tty/{name}/device"));
        let canon = fs::canonicalize(&link).ok()?;
        canon
            .ancestors()
            .filter_map(|dir| dir.file_name())
            .map(|f| f.to_string_lossy().into_owned())
            .find_map(|segment| segment.rsplit_once(":1.").map(|(_, n)| n.to_string()))
            .and_then(|n| n.parse::<u8>().ok())
    }

    /// Order a modem's ttyUSB ports so the AT port is tried first.
    ///
    /// The kernel does not hand out ttyUSB numbers in interface order, so the AT
    /// port is chosen by interface. The MODEM port also answers a bare "AT", so a
    /// wrong choice is not caught by probing and must be avoided here.
    pub fn at_probe_order(ports: &[String]) -> Vec<String> {
        Self::at_probe_order_in(std::path::Path::new("/"), ports)
    }

    /// `at_probe_order` against a sysfs mounted somewhere other than `/`.
    pub fn at_probe_order_in(root: &std::path::Path, ports: &[String]) -> Vec<String> {
        let at_slot = ports
            .iter()
            .position(|p| Self::usb_interface_for_port_in(root, p) == Some(2))
            .or_else(|| (ports.len() == 4).then_some(2));
        let mut order: Vec<String> = Vec::with_capacity(ports.len());
        if let Some(slot) = at_slot.and_then(|i| ports.get(i)) {
            order.push(slot.clone());
        }
        for (i, p) in ports.iter().enumerate() {
            if Some(i) != at_slot {
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
        Self::pick_voice_ports_in(std::path::Path::new("/"), groups, at_port)
    }

    /// `pick_voice_ports` against a sysfs mounted somewhere other than `/`.
    pub fn pick_voice_ports_in(
        root: &std::path::Path,
        groups: &BTreeMap<String, Vec<String>>,
        at_port: &str,
    ) -> Option<VoicePorts> {
        let ports = groups
            .values()
            .find(|ports| ports.iter().any(|p| p == at_port))?;
        // A slimmed modem has no NMEA interface, so this falls through to the
        // layout check below and voice stays unavailable there.
        let by_interface = |wanted: u8| {
            ports
                .iter()
                .find(|p| Self::usb_interface_for_port_in(root, p) == Some(wanted))
                .cloned()
        };
        if let (Some(nmea), Some(modem)) = (by_interface(1), by_interface(3)) {
            return Some(VoicePorts { nmea, modem });
        }
        // Sysfs unreadable: assume the default DIAG/NMEA/AT/MODEM layout.
        let at_index = ports.iter().position(|p| p == at_port)?;
        if at_index != 2 || ports.len() != 4 {
            return None;
        }
        Some(VoicePorts {
            nmea: ports.get(1)?.clone(),
            modem: ports.get(3)?.clone(),
        })
    }
}
