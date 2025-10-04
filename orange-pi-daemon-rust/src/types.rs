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
