use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct Config {
    pub api_url: String,
    pub api_key: String,
    pub check_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub phone_iccid: String,
    pub phone_number: String,
    pub content: String,
    pub timestamp: String,
    pub direction: String, // "received" or "sent"
}

// Normalized modem data (hardware)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Modem {
    pub equipment_id: String,  // IMEI
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub status: String,        // "connected", "disconnected"
    pub signal: Option<i32>,   // Signal percent for modem_state
}

// Normalized SIM data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sim {
    pub iccid: String,
    pub phone_number: Option<String>,
    pub current_modem_id: Option<String>, // Equipment ID it's inserted into
    pub operator_name: Option<String>,
    pub status: String,        // "active", "inactive"
}

// Legacy Phone structure for backward compatibility
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phone {
    pub id: String,         // Equipment ID (IMEI)
    pub iccid: String,
    pub phone_number: Option<String>,
    pub signal_percent: i32,
    pub operator_name: Option<String>,
    pub status: String,     // "connected", "disconnected"
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware: Option<String>,
    pub hardware: Option<String>,
}

impl Phone {
    /// Convert Phone into separate Modem and Sim structs
    pub fn into_normalized(self) -> (Modem, Sim) {
        let modem = Modem {
            equipment_id: self.id.clone(),
            manufacturer: self.manufacturer,
            model: self.model,
            firmware_revision: self.firmware,
            hardware_revision: self.hardware,
            status: self.status.clone(),
            signal: Some(self.signal_percent),
        };
        
        let sim = Sim {
            iccid: self.iccid,
            phone_number: self.phone_number,
            current_modem_id: Some(self.id),
            operator_name: self.operator_name,
            status: if self.status == "connected" { "active".to_string() } else { "inactive".to_string() },
        };
        
        (modem, sim)
    }
}

#[derive(Debug, Clone)]
pub struct SignalData {
    pub percent: i32,
    pub rssi: i32,
}

impl Default for SignalData {
    fn default() -> Self {
        Self {
            percent: 0,
            rssi: -110,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PendingSms {
    pub id: i64,
    pub recipient: String,
    pub message: String,
    pub phone_iccid: String,
}
