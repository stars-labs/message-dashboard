//! Every request and response body that crosses the daemon-Worker boundary.
//! `cargo test` writes TypeScript declarations for each type to
//! `sms-dashboard/shared/daemon-wire/`, which the Worker's valibot schemas are
//! checked against by `tsc`.

use crate::identifiers::{Iccid, Imei, SmsAddress};
use crate::types::SmsSubmission;
use rusqlite::types::{FromSql, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use std::fmt;
use ts_rs::TS;

pub const HEALTH_SCHEMA_VERSION: u8 = 3;

macro_rules! open_string_enum {
    (
        $(#[$meta:meta])*
        $name:ident, $ts:literal {
            $($(#[$variant_meta:meta])* $variant:ident = $text:literal),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, TS)]
        #[ts(export, type = $ts)]
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

            #[cfg(test)]
            const KNOWN: &'static [&'static str] = &[$($text),+];
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

open_string_enum! {
    /// Whether an SMS was received or sent. Text from the local store or the
    /// Worker that is neither is kept verbatim in `Unknown`.
    Direction, "'received' | 'sent' | (string & {})" {
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
    Purpose, "'user' | 'balance_maintenance' | (string & {})" {
        #[default]
        User = "user",
        BalanceMaintenance = "balance_maintenance",
    }
}

open_string_enum! {
    /// The Worker's verdict on one uploaded message. A status the daemon does
    /// not know is kept in `Unknown`, and the upload is retried.
    UploadStatus, "'stored' | 'already_stored' | 'rejected' | (string & {})" {
        Stored = "stored",
        AlreadyStored = "already_stored",
        Rejected = "rejected",
    }
}

/// Why a call ended, as reported to the Worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ModemStatus {
    Active,
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SyncMode {
    Full,
    Incremental,
}

impl SyncMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SyncMode::Full => "full",
            SyncMode::Incremental => "incremental",
        }
    }
}

/// One per modem, sent in `ModemReportsRequest::modem_reports`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ModemReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detected_iccid: Option<Iccid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detected_operator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detected_phone_number: Option<crate::identifiers::SimNumber>,
    pub equipment_id: Imei,
    pub firmware_revision: Option<String>,
    pub hardware_revision: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub modem_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rssi: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signal_percent: Option<i32>,
    pub status: ModemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usb_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usb_port: Option<i32>,
}

/// `POST /api/control/devices`
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ModemReportsRequest<'a> {
    pub modem_reports: &'a [ModemReport],
    pub removed_equipment_ids: &'a [Imei],
    pub session_id: &'a str,
    pub sync_mode: SyncMode,
    pub timestamp: &'a str,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct UploadedMessage<'a> {
    pub content: &'a str,
    pub direction: &'a Direction,
    pub id: &'a str,
    pub phone_iccid: &'a Iccid,
    pub phone_number: &'a SmsAddress,
    pub timestamp: &'a str,
}

/// `POST /api/control/messages`
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct MessageBatchRequest<'a> {
    pub messages: Vec<UploadedMessage<'a>>,
}

/// One entry of the Worker's answer to a message upload.
#[derive(Debug, Deserialize, TS)]
#[ts(export)]
pub struct UploadResult {
    pub id: String,
    pub status: UploadStatus,
    #[serde(default)]
    #[ts(as = "Option<bool>", optional)]
    pub retryable: bool,
}

/// The Worker's answer to `POST /api/control/messages`.
#[derive(Debug, Deserialize, TS)]
#[ts(export)]
pub struct UploadResponse {
    pub results: Vec<UploadResult>,
}

/// `POST /api/control/calls/incoming`
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct IncomingCallRequest<'a> {
    pub from: Option<&'a str>,
    pub iccid: &'a Iccid,
}

/// `POST /api/control/calls/ended`
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct EndedCallRequest<'a> {
    pub call_id: Option<&'a str>,
    pub iccid: &'a Iccid,
    pub reason: CallEndReason,
}

#[derive(Debug, Clone, Serialize, Default, TS)]
#[ts(export)]
pub struct QueueHealthSnapshot {
    pub pending: usize,
    pub in_flight: usize,
    pub dead_letter: usize,
    #[ts(type = "number | null")]
    pub oldest_unacknowledged_age_seconds: Option<u64>,
}

/// `POST /api/control/heartbeat`
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct HealthSnapshot {
    #[ts(type = "3")]
    pub schema_version: u8,
    pub session_id: String,
    pub version: String,
    #[ts(type = "number")]
    pub uptime_seconds: u64,
    #[ts(type = "number | null")]
    pub last_message_read_success_age_seconds: Option<u64>,
    #[ts(type = "number | null")]
    pub last_upload_success_age_seconds: Option<u64>,
    pub queue: QueueHealthSnapshot,
}

/// One SMS the Worker wants the daemon to send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PendingSms {
    pub id: String,
    pub recipient: SmsAddress,
    pub phone_iccid: String,
    pub content: String,
    #[serde(default)]
    #[ts(as = "Option<Purpose>", optional)]
    pub purpose: Purpose,
    pub created_at: String,
}

/// The Worker's answer to `GET /api/control/pending-sms`.
#[derive(Debug, Deserialize, TS)]
#[ts(export)]
pub struct PendingSmsResponse {
    pub pending_messages: Vec<PendingSms>,
}

// Unlike `SmsSubmission`, this includes transport failures.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SmsReportOutcome {
    Confirmed,
    SubmittedUnconfirmed,
    Failed,
}

/// `POST /api/control/sms-result`
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct SmsResult<'a> {
    pub message_id: &'a str,
    pub outcome: SmsReportOutcome,
    pub error_message: Option<&'a str>,
}

impl<'a> SmsResult<'a> {
    pub fn new(message_id: &'a str, submission: Result<SmsSubmission, &'a str>) -> Self {
        let (outcome, error_message) = match submission {
            Ok(SmsSubmission::Confirmed) => (SmsReportOutcome::Confirmed, None),
            Ok(SmsSubmission::SubmittedUnconfirmed) => (
                SmsReportOutcome::SubmittedUnconfirmed,
                Some("SMS body submitted; modem did not return a final confirmation"),
            ),
            Err(error) => (SmsReportOutcome::Failed, Some(error)),
        };
        Self {
            message_id,
            outcome,
            error_message,
        }
    }
}

#[cfg(test)]
mod tests;
