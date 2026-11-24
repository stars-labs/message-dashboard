use crate::identifiers::{Iccid, Imei, SimNumber, SmsAddress};
use crate::wire::{Direction, ModemStatus};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use std::fmt;

/// A submitted SMS; submission failures are returned through `Result::Err`.
///
/// ```
/// use orange_pi_daemon_rust::types::SmsSubmission;
/// let submission: Result<SmsSubmission, &str> = Ok(SmsSubmission::Confirmed);
/// assert_eq!(submission, Ok(SmsSubmission::Confirmed));
/// ```
///
/// A failed send cannot be constructed as a successful submission:
///
/// ```compile_fail,E0599
/// use orange_pi_daemon_rust::types::SmsSubmission;
/// let submission: Result<SmsSubmission, &str> = Ok(SmsSubmission::Failed);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmsSubmission {
    Confirmed,
    SubmittedUnconfirmed,
}

/// The CPMS mem1 storage an SMS is read from or deleted in. Parsing ignores
/// ASCII case; the canonical text is upper case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmsStorage {
    Me,
    Sm,
    Mt,
}

impl SmsStorage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Me => "ME",
            Self::Sm => "SM",
            Self::Mt => "MT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown SMS storage: {0}")]
pub struct UnknownSmsStorage(pub String);

impl std::str::FromStr for SmsStorage {
    type Err = UnknownSmsStorage;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text.to_ascii_uppercase().as_str() {
            "ME" => Ok(Self::Me),
            "SM" => Ok(Self::Sm),
            "MT" => Ok(Self::Mt),
            _ => Err(UnknownSmsStorage(text.to_string())),
        }
    }
}

impl fmt::Display for SmsStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl ToSql for SmsStorage {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}

impl FromSql for SmsStorage {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value
            .as_str()?
            .parse()
            .map_err(|error: UnknownSmsStorage| FromSqlError::Other(error.into()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimStatus {
    Active,
    Inactive,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhoneStatus {
    Active,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimReadStatus {
    Ok,
    Failed,
}

/// `ModemManager`'s `MMModemState`, as reported over D-Bus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModemState {
    Failed,
    Locked,
    Disabled,
    Disabling,
    Enabling,
    Enabled,
    Searching,
    Registered,
    Disconnecting,
    Connecting,
    Connected,
    Unknown,
}

impl ModemState {
    pub fn from_code(code: i32) -> Self {
        match code {
            0 => Self::Failed,
            2 => Self::Locked,
            3 => Self::Disabled,
            4 => Self::Disabling,
            5 => Self::Enabling,
            6 => Self::Enabled,
            7 => Self::Searching,
            8 => Self::Registered,
            9 => Self::Disconnecting,
            10 => Self::Connecting,
            11 => Self::Connected,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Failed => "failed",
            Self::Locked => "locked",
            Self::Disabled => "disabled",
            Self::Disabling => "disabling",
            Self::Enabling => "enabling",
            Self::Enabled => "enabled",
            Self::Searching => "searching",
            Self::Registered => "registered",
            Self::Disconnecting => "disconnecting",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ModemState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub api_url: String,
    pub api_key: String,
    pub check_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub phone_iccid: Iccid,
    pub phone_number: SmsAddress,
    pub content: String,
    pub timestamp: String,
    pub direction: Direction,
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
    pub equipment_id: Imei, // IMEI (Primary Key)
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub status: ModemStatus,

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
    pub sim_read_status: Option<SimReadStatus>,
}

// Normalized SIM data - matches server schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sim {
    pub iccid: Iccid, // ICCID (Primary Key)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<SimNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_modem_id: Option<Imei>, // Foreign Key to Modem.equipment_id
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_id: Option<String>,
    pub status: SimStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sim_index: Option<i32>,
}

// Phone structure matching API expectations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phone {
    pub iccid: Iccid,
    pub number: Option<SimNumber>,
    pub signal: Option<i32>,
    pub operator_name: Option<String>,
    pub status: PhoneStatus,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub imei: Option<Imei>,
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
    pub sim_read_status: Option<SimReadStatus>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn wire<T: Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn sms_storage_text_is_unchanged() {
        for (storage, text) in [
            (SmsStorage::Me, "ME"),
            (SmsStorage::Sm, "SM"),
            (SmsStorage::Mt, "MT"),
        ] {
            assert_eq!(storage.as_str(), text);
            assert_eq!(storage.to_string(), text);
            assert_eq!(text.parse::<SmsStorage>().unwrap(), storage);
            assert_eq!(
                text.to_ascii_lowercase().parse::<SmsStorage>().unwrap(),
                storage
            );
        }
        for text in ["", "SR", "BM", "M E", "ME ", "MÉ"] {
            assert_eq!(
                text.parse::<SmsStorage>(),
                Err(UnknownSmsStorage(text.to_string()))
            );
        }
    }

    #[test]
    fn sms_storage_is_stored_as_the_same_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (storage TEXT NOT NULL)", [])
            .unwrap();
        for storage in [SmsStorage::Me, SmsStorage::Sm, SmsStorage::Mt] {
            conn.execute("DELETE FROM t", []).unwrap();
            conn.execute("INSERT INTO t VALUES (?1)", [&storage])
                .unwrap();
            let text: String = conn
                .query_row("SELECT storage FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(text, storage.as_str());
            let read: SmsStorage = conn
                .query_row("SELECT storage FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(read, storage);
        }
        conn.execute("DELETE FROM t", []).unwrap();
        conn.execute("INSERT INTO t VALUES ('sm')", []).unwrap();
        let read: SmsStorage = conn
            .query_row("SELECT storage FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(read, SmsStorage::Sm);
        conn.execute("DELETE FROM t", []).unwrap();
        conn.execute("INSERT INTO t VALUES ('SR')", []).unwrap();
        assert!(conn
            .query_row("SELECT storage FROM t", [], |row| row
                .get::<_, SmsStorage>(0))
            .is_err());
    }

    #[test]
    fn closed_status_enums_keep_their_wire_strings() {
        for (status, text) in [
            (ModemStatus::Active, "active"),
            (ModemStatus::Connected, "connected"),
            (ModemStatus::Disconnected, "disconnected"),
        ] {
            assert_eq!(wire(&status), json!(text));
            assert_eq!(
                serde_json::from_value::<ModemStatus>(json!(text)).unwrap(),
                status
            );
        }
        for (status, text) in [
            (SimStatus::Active, "active"),
            (SimStatus::Inactive, "inactive"),
            (SimStatus::Removed, "removed"),
        ] {
            assert_eq!(wire(&status), json!(text));
            assert_eq!(
                serde_json::from_value::<SimStatus>(json!(text)).unwrap(),
                status
            );
        }
        for (status, text) in [
            (PhoneStatus::Active, "active"),
            (PhoneStatus::Offline, "offline"),
        ] {
            assert_eq!(wire(&status), json!(text));
            assert_eq!(
                serde_json::from_value::<PhoneStatus>(json!(text)).unwrap(),
                status
            );
        }
        for (status, text) in [(SimReadStatus::Ok, "ok"), (SimReadStatus::Failed, "failed")] {
            assert_eq!(wire(&status), json!(text));
            assert_eq!(
                serde_json::from_value::<SimReadStatus>(json!(text)).unwrap(),
                status
            );
        }
        assert!(serde_json::from_value::<ModemStatus>(json!("error")).is_err());
    }

    #[test]
    fn modem_state_codes_keep_their_names() {
        for (code, text) in [
            (0, "failed"),
            (2, "locked"),
            (3, "disabled"),
            (4, "disabling"),
            (5, "enabling"),
            (6, "enabled"),
            (7, "searching"),
            (8, "registered"),
            (9, "disconnecting"),
            (10, "connecting"),
            (11, "connected"),
            (1, "unknown"),
            (12, "unknown"),
            (-1, "unknown"),
        ] {
            assert_eq!(ModemState::from_code(code).to_string(), text);
        }
    }
}
