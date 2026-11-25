use super::ModemManager;
use crate::types::SmsStorage;
use anyhow::{anyhow, Result};

impl ModemManager {
    pub(super) fn format_at_sms_path(locations: &[(SmsStorage, u32)]) -> String {
        let encoded = locations
            .iter()
            .map(|(storage, index)| format!("{storage}:{index}"))
            .collect::<Vec<_>>()
            .join(",");
        format!("at:{encoded}")
    }

    /// Parse both storage-aware `at:ME:5,SM:7` paths and legacy `at:5,7` paths.
    pub(super) fn parse_at_sms_path(sms_path: &str) -> Result<Vec<(Option<SmsStorage>, u32)>> {
        let encoded = sms_path
            .strip_prefix("at:")
            .ok_or_else(|| anyhow!("Invalid AT SMS path: {sms_path}"))?;
        if encoded.is_empty() {
            return Err(anyhow!("AT SMS path contains no locations: {sms_path}"));
        }

        encoded
            .split(',')
            .map(|location| {
                if let Some((storage, index)) = location.split_once(':') {
                    let storage = storage.parse::<SmsStorage>().map_err(|_| {
                        anyhow!(
                            "Invalid SMS storage in path: {}",
                            storage.to_ascii_uppercase()
                        )
                    })?;
                    let index = index
                        .parse::<u32>()
                        .map_err(|_| anyhow!("Invalid SMS index: {index}"))?;
                    Ok((Some(storage), index))
                } else {
                    let index = location
                        .parse::<u32>()
                        .map_err(|_| anyhow!("Invalid SMS index: {location}"))?;
                    Ok((None, index))
                }
            })
            .collect()
    }
}
