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

// Phone structure matching API expectations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phone {
    pub iccid: String,
    pub number: Option<String>,
    pub signal: Option<i32>,
    pub operator_name: Option<String>,
    pub status: String,     // "active", "offline"
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub imei: Option<String>,
    // Optional fields for compatibility
    pub country: Option<String>,
    pub flag: Option<String>,
    pub carrier: Option<String>,
    pub rssi: Option<i32>,
    pub rsrq: Option<i32>,
    pub rsrp: Option<i32>,
    pub snr: Option<i32>,
    pub operator_id: Option<String>,
    pub access_tech: Option<String>,
    pub modem_index: Option<i32>,
    pub sim_index: Option<i32>,
    pub device_path: Option<String>,
    pub usb_port: Option<String>,
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
