use rusqlite::types::{FromSql, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! open_string_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$variant_meta:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum $name {
            $($(#[$variant_meta])* $variant,)+
            Unknown(String),
        }

        impl $name {
            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $text,)+
                    Self::Unknown(other) => other,
                }
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                match value.as_str() {
                    $($text => Self::$variant,)+
                    _ => Self::Unknown(value),
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                String::deserialize(deserializer).map(Self::from)
            }
        }
    };
}

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

open_string_enum! {
    /// Whether an SMS was received or sent. Text from the local store or the
    /// Worker that is neither is kept verbatim in `Unknown`.
    Direction {
        Received = "received",
        Sent = "sent",
    }
}

impl ToSql for Direction {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}

impl FromSql for Direction {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value.as_str().map(|text| Self::from(text.to_owned()))
    }
}

open_string_enum! {
    /// Why the Worker queued an outbound SMS. A missing purpose is `User`.
    #[derive(Default)]
    Purpose {
        #[default]
        User = "user",
        BalanceMaintenance = "balance_maintenance",
    }
}

open_string_enum! {
    /// The Worker's verdict on one uploaded message. A status the daemon does
    /// not know is kept in `Unknown`, and the upload is retried.
    UploadStatus {
        Stored = "stored",
        AlreadyStored = "already_stored",
        Rejected = "rejected",
    }
}

/// Why a call ended, as reported to the Worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallEndReason {
    SetupFailed,
    Missed,
    RemoteHangup,
    AdapterMissing,
    MaxDuration,
    Stopped,
    NmeaError,
    AdapterClosed,
}

impl CallEndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SetupFailed => "setup_failed",
            Self::Missed => "missed",
            Self::RemoteHangup => "remote_hangup",
            Self::AdapterMissing => "adapter_missing",
            Self::MaxDuration => "max_duration",
            Self::Stopped => "stopped",
            Self::NmeaError => "nmea_error",
            Self::AdapterClosed => "adapter_closed",
        }
    }
}

impl fmt::Display for CallEndReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModemStatus {
    Active,
    Connected,
    Disconnected,
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
    pub phone_iccid: String,
    pub phone_number: String,
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
    pub equipment_id: String, // IMEI (Primary Key)
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
    pub iccid: String, // ICCID (Primary Key)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_modem_id: Option<String>, // Foreign Key to Modem.equipment_id
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
    pub iccid: String,
    pub number: Option<String>,
    pub signal: Option<i32>,
    pub operator_name: Option<String>,
    pub status: PhoneStatus,
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
    pub sim_read_status: Option<SimReadStatus>,
}

/// Flat modem report for the new single-struct API (migration 033+)
/// One struct per modem, sent as `{ modem_reports: [...] }` to the server
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModemReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_iccid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_operator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_phone_number: Option<String>,
    pub equipment_id: String,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modem_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rssi: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_percent: Option<i32>,
    pub status: ModemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_port: Option<i32>,
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

/// The Worker's pending SMS payload, shared by the API client and sender.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingSms {
    pub id: String,
    pub recipient: String,
    pub phone_iccid: String,
    pub content: String,
    #[serde(default)]
    pub purpose: Purpose,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PendingSmsResponse {
    pub pending_messages: Vec<PendingSms>,
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
    fn direction_wire_form_is_unchanged() {
        assert_eq!(wire(&Direction::Received), json!("received"));
        assert_eq!(wire(&Direction::Sent), json!("sent"));
        assert_eq!(
            serde_json::from_value::<Direction>(json!("received")).unwrap(),
            Direction::Received
        );
        assert_eq!(
            serde_json::from_value::<Direction>(json!("sent")).unwrap(),
            Direction::Sent
        );
    }

    #[test]
    fn direction_keeps_text_it_does_not_know() {
        let direction = serde_json::from_value::<Direction>(json!("test")).unwrap();
        assert_eq!(direction, Direction::Unknown("test".to_string()));
        assert_eq!(wire(&direction), json!("test"));
        assert_eq!(direction.to_string(), "test");
        assert!(serde_json::from_value::<Direction>(json!(null)).is_err());
    }

    #[test]
    fn direction_is_stored_as_the_same_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (direction TEXT NOT NULL)", [])
            .unwrap();
        for direction in [
            Direction::Received,
            Direction::Sent,
            Direction::Unknown("legacy".to_string()),
        ] {
            conn.execute("DELETE FROM t", []).unwrap();
            conn.execute("INSERT INTO t VALUES (?1)", [&direction])
                .unwrap();
            let text: String = conn
                .query_row("SELECT direction FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(text, direction.as_str());
            let read: Direction = conn
                .query_row("SELECT direction FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(read, direction);
        }
        conn.execute("DELETE FROM t", []).unwrap();
        conn.execute("INSERT INTO t VALUES ('received')", [])
            .unwrap();
        let read: Direction = conn
            .query_row("SELECT direction FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(read, Direction::Received);
    }

    #[test]
    fn purpose_wire_form_and_default_are_unchanged() {
        assert_eq!(wire(&Purpose::User), json!("user"));
        assert_eq!(
            wire(&Purpose::BalanceMaintenance),
            json!("balance_maintenance")
        );
        assert_eq!(Purpose::default(), Purpose::User);
        assert_eq!(
            serde_json::from_value::<Purpose>(json!("balance_maintenance")).unwrap(),
            Purpose::BalanceMaintenance
        );
        let other = serde_json::from_value::<Purpose>(json!("promo")).unwrap();
        assert_eq!(other, Purpose::Unknown("promo".to_string()));
        assert_eq!(wire(&other), json!("promo"));
    }

    #[test]
    fn upload_status_wire_form_and_unknown_are_unchanged() {
        for (text, status) in [
            ("stored", UploadStatus::Stored),
            ("already_stored", UploadStatus::AlreadyStored),
            ("rejected", UploadStatus::Rejected),
        ] {
            assert_eq!(wire(&status), json!(text));
            assert_eq!(
                serde_json::from_value::<UploadStatus>(json!(text)).unwrap(),
                status
            );
        }
        let other = serde_json::from_value::<UploadStatus>(json!("throttled")).unwrap();
        assert_eq!(other, UploadStatus::Unknown("throttled".to_string()));
        assert_eq!(wire(&other), json!("throttled"));
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
    fn call_end_reasons_keep_their_wire_strings() {
        for (reason, text) in [
            (CallEndReason::SetupFailed, "setup_failed"),
            (CallEndReason::Missed, "missed"),
            (CallEndReason::RemoteHangup, "remote_hangup"),
            (CallEndReason::AdapterMissing, "adapter_missing"),
            (CallEndReason::MaxDuration, "max_duration"),
            (CallEndReason::Stopped, "stopped"),
            (CallEndReason::NmeaError, "nmea_error"),
            (CallEndReason::AdapterClosed, "adapter_closed"),
        ] {
            assert_eq!(wire(&reason), json!(text));
            assert_eq!(reason.as_str(), text);
            assert_eq!(reason.to_string(), text);
        }
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
