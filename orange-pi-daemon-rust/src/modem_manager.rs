use anyhow::{Context, Result};
use std::process::Command;
use crate::types::*;

pub struct ModemManager;

impl ModemManager {
    pub fn new() -> Self {
        Self
    }
    
    /// List all modem IDs
    pub async fn list_modems(&self) -> Result<Vec<String>> {
        let output = tokio::process::Command::new("mmcli")
            .arg("-L")
            .output()
            .await
            .context("Failed to list modems")?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut modems = Vec::new();
        
        // Parse: /org/freedesktop/ModemManager1/Modem/123
        for line in stdout.lines() {
            if let Some(modem_id) = Self::extract_modem_id(line) {
                modems.push(modem_id);
            }
        }
        
        Ok(modems)
    }
    
    /// Get ICCID for a modem
    pub async fn get_iccid(&self, modem_id: &str) -> Result<Option<String>> {
        // First get SIM path
        let output = tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Extract SIM path: sim: /org/freedesktop/ModemManager1/SIM/123
        let sim_id = stdout
            .lines()
            .find(|l| l.trim().starts_with("sim:") || l.contains("/SIM/"))
            .and_then(|l| l.split("/SIM/").nth(1))
            .and_then(|s| s.split_whitespace().next());
        
        let sim_id = match sim_id {
            Some(id) => id,
            None => return Ok(None),
        };
        
        // Query SIM for ICCID
        let sim_output = tokio::process::Command::new("mmcli")
            .arg("-i")
            .arg(sim_id)
            .output()
            .await?;
        
        let sim_stdout = String::from_utf8_lossy(&sim_output.stdout);
        
        // Extract ICCID: iccid: 1234567890
        let iccid = sim_stdout
            .lines()
            .find(|l| l.contains("iccid:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string());
        
        Ok(iccid)
    }
    
    /// Get phone number
    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<String>> {
        let output = tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Extract: own: +1234567890
        let number = stdout
            .lines()
            .find(|l| l.contains("own:") || l.contains("number:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "unknown");
        
        Ok(number)
    }
    
    /// Get signal quality
    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        let output = tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Parse: signal quality: 75% (recent)
        let percent = stdout
            .lines()
            .find(|l| l.contains("signal quality:"))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|s| s.trim().split('%').next())
            .and_then(|s| s.trim().parse::<i32>().ok())
            .unwrap_or(0);
        
        Ok(SignalData {
            percent,
            rssi: (percent * 120 / 100) - 110, // Approximate RSSI from percentage
        })
    }
    
    /// Get new SMS messages
    pub async fn get_new_messages(&self, modem_id: &str, iccid: &str) -> Result<Vec<Message>> {
        // List SMS
        let output = tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .arg("--messaging-list-sms")
            .output()
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut messages = Vec::new();
        
        // Extract SMS IDs
        for line in stdout.lines() {
            if let Some(sms_id) = Self::extract_sms_id(line) {
                if let Ok(Some(msg)) = self.read_sms(modem_id, &sms_id, iccid).await {
                    messages.push(msg);
                    // Delete after reading to prevent reprocessing
                    let _ = self.delete_sms(modem_id, &sms_id).await;
                }
            }
        }
        
        Ok(messages)
    }
    
    /// Read a specific SMS
    async fn read_sms(&self, modem_id: &str, sms_id: &str, iccid: &str) -> Result<Option<Message>> {
        let output = tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .arg("--sms")
            .arg(sms_id)
            .output()
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Parse SMS fields
        let mut content = String::new();
        let mut number = String::new();
        let mut timestamp = String::new();
        
        for line in stdout.lines() {
            let line = line.trim();
            if line.contains("text:") {
                content = line.split(':').skip(1).collect::<Vec<_>>().join(":").trim().to_string();
            } else if line.contains("number:") {
                number = line.split(':').nth(1).unwrap_or("").trim().to_string();
            } else if line.contains("timestamp:") {
                // Parse timestamp properly - mmcli format: "timestamp: 2025-10-05T14:23:45+08:00"
                // We need to preserve the entire timestamp including timezone
                let ts_parts: Vec<&str> = line.splitn(2, ':').collect();
                if ts_parts.len() == 2 {
                    timestamp = ts_parts[1].trim().to_string();
                }
            }
        }
        
        if content.is_empty() {
            return Ok(None);
        }
        
        Ok(Some(Message {
            phone_iccid: iccid.to_string(),
            phone_number: number,
            content,
            timestamp,
            direction: "received".to_string(),
        }))
    }
    
    /// Delete SMS after processing
    pub async fn delete_sms(&self, modem_id: &str, sms_id: &str) -> Result<()> {
        tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .arg("--messaging-delete-sms")
            .arg(sms_id)
            .output()
            .await?;
        
        Ok(())
    }
    
    /// Get device details (IMEI, manufacturer, model, etc.)
    pub async fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
        let output = tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let mut imei = String::new();
        let mut manufacturer = None;
        let mut model = None;
        let mut firmware = None;
        let hardware = None;
        
        for line in stdout.lines() {
            let line = line.trim();
            if line.contains("equipment id:") {
                imei = line.split(':').nth(1).unwrap_or("").trim().to_string();
            } else if line.contains("manufacturer:") {
                manufacturer = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            } else if line.contains("model:") {
                model = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            } else if line.contains("firmware") || line.contains("revision:") {
                firmware = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
            }
        }
        
        // Generate synthetic IMEI if missing
        if imei.is_empty() {
            imei = format!("MODEM_{}", modem_id);
        }
        
        Ok((imei, manufacturer, model, firmware, hardware))
    }
    
    /// Get operator name
    pub async fn get_operator(&self, modem_id: &str) -> Result<Option<String>> {
        let output = tokio::process::Command::new("mmcli")
            .arg("-m")
            .arg(modem_id)
            .output()
            .await?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let operator = stdout
            .lines()
            .find(|l| l.contains("operator name:"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        
        Ok(operator)
    }
    
    // Helper functions
    fn extract_modem_id(line: &str) -> Option<String> {
        line.split("/Modem/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .map(|s| s.to_string())
    }
    
    fn extract_sms_id(line: &str) -> Option<String> {
        line.split("/SMS/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .map(|s| s.to_string())
    }
}
