use super::AtModemManager;
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
        Iccid::try_from(iccid.trim_end_matches(['F', 'f'])).ok()
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_iccid_strips_trailing_filler_and_rejects_pure_filler() {
        assert_eq!(
            AtModemManager::normalize_iccid("8965012306052989707F"),
            Iccid::try_from("8965012306052989707").ok()
        );
        assert_eq!(
            AtModemManager::normalize_iccid("89650123060529897FFF"),
            Iccid::try_from("89650123060529897").ok()
        );
        assert_eq!(AtModemManager::normalize_iccid("FFFF"), None);
    }
}
