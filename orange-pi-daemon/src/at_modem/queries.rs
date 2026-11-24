use super::{AtModemManager, ImsStatus, ModemHealth, NetworkRegStatus, SmsConfig, SmsMode};
use crate::identifiers::{Iccid, Imei, SimNumber};
use anyhow::Result;

impl AtModemManager {
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

    pub(super) fn parse_iccid(response: &str) -> Option<Iccid> {
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

    pub(super) fn parse_imei(response: &str) -> Option<Imei> {
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
    pub(super) fn parse_cnum(response: &str) -> Option<SimNumber> {
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
            .map(ToString::to_string)
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
}
