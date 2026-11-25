use super::ModemManager;
use crate::identifiers::{Iccid, Imei, SimNumber};
use crate::types::SignalData;
use anyhow::{anyhow, Result};
use tracing::debug;

pub(super) fn signal_from_percent(percent: u32) -> Result<SignalData> {
    let percent =
        i32::try_from(percent).map_err(|_| anyhow!("signal quality {percent}% out of range"))?;
    Ok(SignalData {
        percent,
        rssi: (percent * 120 / 100) - 110,
    })
}

impl ModemManager {
    pub async fn get_iccid(&self, modem_id: &str) -> Result<Option<Iccid>> {
        let port = self.get_port(modem_id).await;
        self.at_modem.get_iccid(&port).await
    }

    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        if let Some(cached) = self.signal_cache.get(modem_id).await {
            return Ok(cached);
        }

        let port = self.get_port(modem_id).await;
        let percent = self.at_modem.get_signal(&port).await?;
        let signal = signal_from_percent(percent)?;

        self.signal_cache
            .set(modem_id.to_string(), signal.clone())
            .await;
        Ok(signal)
    }

    pub async fn get_device_details(
        &self,
        modem_id: &str,
    ) -> Result<
        Option<(
            Imei,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )>,
    > {
        let port = self.get_port(modem_id).await;
        let info = self.at_modem.get_modem_info(&port).await?;

        if let Some(imei) = info.imei {
            return Ok(Some((
                imei,
                info.manufacturer,
                info.model,
                info.revision,
                None,
            )));
        }
        debug!("Modem {} has no valid IMEI", modem_id);
        Ok(None)
    }

    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<SimNumber>> {
        let port = self.get_port(modem_id).await;
        self.at_modem.get_phone_number(&port).await
    }

    pub async fn get_operator(&self, modem_id: &str) -> Result<Option<String>> {
        let port = self.get_port(modem_id).await;
        self.at_modem.get_operator(&port).await
    }
}
