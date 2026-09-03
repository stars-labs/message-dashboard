use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmsSubmitOutcome {
    Confirmed,
    SubmittedUnconfirmed,
    Failed,
}

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

// Internal structure for tracking messages with their SMS paths
#[derive(Debug, Clone)]
pub struct MessageWithPath {
    pub message: Message,
    pub modem_id: String,
    pub sms_path: String, // D-Bus path for deletion after upload
}

// Normalized modem data (hardware) - matches server schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Modem {
    pub equipment_id: String, // IMEI (Primary Key)
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub status: String, // "connected", "disconnected"

    // Optional modem_state fields (can be included for convenience)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>, // Signal percent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rssi: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsrq: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsrp: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snr: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modem_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_port: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_tech: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sim_read_status: Option<String>, // "ok" or "failed"
}

// Normalized SIM data - matches server schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sim {
    pub iccid: String, // ICCID (Primary Key)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_modem_id: Option<String>, // Foreign Key to Modem.equipment_id
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_id: Option<String>,
    pub status: String, // "active", "inactive", "removed"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sim_index: Option<i32>,
}

// Phone structure matching API expectations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phone {
    pub iccid: String,
    pub number: Option<String>,
    pub signal: Option<i32>,
    pub operator_name: Option<String>,
    pub status: String, // "active", "offline"
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
    pub sim_read_status: Option<String>,
}

/// Flat modem report for the new single-struct API (migration 033+)
/// One struct per modem, sent as `{ modem_reports: [...] }` to the server
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModemReport {
    pub equipment_id: String,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_iccid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_phone_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_operator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_percent: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rssi: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modem_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_port: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_path: Option<String>,
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
