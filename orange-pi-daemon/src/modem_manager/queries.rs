use super::{BackendMode, ModemManager};
use crate::identifiers::{Iccid, Imei, SimNumber};
use crate::types::SignalData;
use anyhow::{anyhow, Result};
use tracing::{debug, info};

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
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                self.at_modem.get_iccid(&port).await
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                client.get_sim_iccid(modem_id).await
            }
        }
    }

    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        if let Some(cached) = self.signal_cache.get(modem_id).await {
            return Ok(cached);
        }

        let signal = match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                let percent = self.at_modem.get_signal(&port).await?;
                signal_from_percent(percent)?
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                let (percent, _) = client.get_signal_quality(modem_id).await?;
                signal_from_percent(percent)?
            }
        };

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
        match self.mode {
            BackendMode::AtCommand => {
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
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                let details = client.get_device_details(modem_id).await?;

                let Some(imei) = details.imei else {
                    return Ok(None);
                };
                Ok(Some((
                    imei,
                    details.manufacturer,
                    details.model,
                    details.firmware_version,
                    details.hardware_revision,
                )))
            }
        }
    }

    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<SimNumber>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                self.at_modem.get_phone_number(&port).await
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                client.get_phone_number(modem_id).await
            }
        }
    }

    pub async fn get_operator(&self, modem_id: &str) -> Result<Option<String>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                self.at_modem.get_operator(&port).await
            }
            BackendMode::DBus => {
                let client = self
                    .dbus_client
                    .as_ref()
                    .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
                client.get_operator(modem_id)
            }
        }
    }

    pub async fn health_check(
        &self,
        modem_id: &str,
    ) -> Result<Option<crate::at_modem::ModemHealth>> {
        match self.mode {
            BackendMode::AtCommand => {
                let port = self.get_port(modem_id).await;
                let health = self.at_modem.health_check(&port).await?;
                Ok(Some(health))
            }
            BackendMode::DBus => {
                info!("Health check not implemented for D-Bus mode");
                Ok(None)
            }
        }
    }
}
