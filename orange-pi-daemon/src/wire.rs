//! Every request and response body that crosses the daemon-Worker boundary.
//!
//! This module is the single source of truth for the contract. `cargo test`
//! writes TypeScript declarations for each type to
//! `sms-dashboard/shared/daemon-wire/` (directory set in `.cargo/config.toml`),
//! and the Worker's valibot schemas are checked against them by `tsc`.

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

/// Sync mode for state reconciliation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SyncMode {
    /// Full state sync - reconcile all devices with server
    Full,
    /// Incremental update - only send changed data
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

/// Flat modem report for the single-struct API (migration 033+).
/// One struct per modem, sent in `ModemReportsRequest::modem_reports`.
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
#[derive(Serialize, TS)]
#[ts(export)]
pub struct ModemReportsRequest<'a> {
    pub modem_reports: &'a [ModemReport],
    pub removed_equipment_ids: &'a [Imei],
    pub session_id: &'a str,
    pub sync_mode: SyncMode,
    pub timestamp: &'a str,
}

#[derive(Serialize, TS)]
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
#[derive(Serialize, TS)]
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
#[derive(Serialize, TS)]
#[ts(export)]
pub struct IncomingCallRequest<'a> {
    pub from: Option<&'a str>,
    pub iccid: &'a Iccid,
}

/// `POST /api/control/calls/ended`
#[derive(Serialize, TS)]
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

// The transport includes failures, while successful modem submissions cannot.
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
mod tests {
    use super::*;
    use crate::message_store::{MessageStatus, StoredMessage};
    use crate::types::Message;
    use rusqlite::Connection;
    use serde_json::json;

    const ICCID: &str = "898600000000000000f1";

    fn iccid() -> Iccid {
        Iccid::try_from(ICCID).unwrap()
    }

    fn wire<T: Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).unwrap()
    }

    fn text<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    fn ts_of<T: TS>() -> String {
        T::inline(&ts_rs::Config::default())
    }

    fn report() -> ModemReport {
        ModemReport {
            equipment_id: Imei::try_from("860000000000001").unwrap(),
            manufacturer: Some("Quectel".to_string()),
            model: None,
            firmware_revision: None,
            hardware_revision: None,
            status: ModemStatus::Active,
            detected_iccid: Some(iccid()),
            detected_phone_number: None,
            detected_operator: None,
            signal_percent: Some(80),
            rssi: Some(-70),
            modem_index: Some(3),
            usb_port: None,
            usb_path: Some("1-1.4".to_string()),
        }
    }

    fn open_enum_ts(known: &[&str]) -> String {
        let literals: Vec<String> = known.iter().map(|text| format!("'{text}'")).collect();
        format!("{} | (string & {{}})", literals.join(" | "))
    }

    #[test]
    fn open_enum_typescript_lists_every_known_variant() {
        assert_eq!(ts_of::<Direction>(), open_enum_ts(Direction::KNOWN));
        assert_eq!(ts_of::<Purpose>(), open_enum_ts(Purpose::KNOWN));
        assert_eq!(ts_of::<UploadStatus>(), open_enum_ts(UploadStatus::KNOWN));
    }

    #[test]
    fn health_schema_version_matches_its_typescript_literal() {
        assert!(
            ts_of::<HealthSnapshot>().contains(&format!("schema_version: {HEALTH_SCHEMA_VERSION}"))
        );
    }

    #[test]
    fn identifier_typescript_is_a_brand_named_after_the_type() {
        let cfg = ts_rs::Config::default();
        assert_eq!(
            Iccid::inline(&cfg),
            "string & import('valibot').Brand<'Iccid'>"
        );
        assert_eq!(
            Imei::inline(&cfg),
            "string & import('valibot').Brand<'Imei'>"
        );
        assert_eq!(
            crate::identifiers::PhoneNumber::inline(&cfg),
            "string & import('valibot').Brand<'PhoneNumber'>"
        );
        assert_eq!(
            crate::identifiers::SimNumber::inline(&cfg),
            "string & import('valibot').Brand<'SimNumber'>"
        );
        assert_eq!(
            SmsAddress::inline(&cfg),
            "string & import('valibot').Brand<'SmsAddress'>"
        );
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
    fn sync_mode_wire_form_matches_its_log_text() {
        for (mode, text) in [
            (SyncMode::Full, "full"),
            (SyncMode::Incremental, "incremental"),
        ] {
            assert_eq!(wire(&mode), json!(text));
            assert_eq!(mode.as_str(), text);
        }
    }

    #[test]
    fn modem_reports_request_matches_the_old_json_body() {
        let reports = [report()];
        let removed = [Imei::try_from("860000000000002").unwrap()];
        let timestamp = "2026-01-02T03:04:05.678Z";
        let new = ModemReportsRequest {
            modem_reports: &reports,
            removed_equipment_ids: &removed,
            session_id: "session-1",
            sync_mode: SyncMode::Incremental,
            timestamp,
        };
        let old = json!({
            "sync_mode": SyncMode::Incremental.as_str(),
            "session_id": "session-1",
            "timestamp": timestamp,
            "modem_reports": reports,
            "removed_equipment_ids": removed,
        });
        assert_eq!(text(&new), text(&old));
        assert_eq!(serde_json::to_value(&new).unwrap(), old);
    }

    #[test]
    fn message_batch_request_matches_the_old_json_body() {
        let stored = StoredMessage {
            id: 7,
            source_message_id: "source-1".to_string(),
            message: Message {
                phone_iccid: iccid(),
                phone_number: SmsAddress::from("+1234567890"),
                content: "code 123456".to_string(),
                timestamp: "2026-01-02T03:04:05.678Z".to_string(),
                direction: Direction::Received,
            },
            modem_id: "3".to_string(),
            sms_path: "at:ME:1".to_string(),
            status: MessageStatus::InFlight,
            attempts: 1,
            lease_token: "lease".to_string(),
        };
        let chunk = [stored];
        let new = MessageBatchRequest {
            messages: chunk.iter().map(UploadedMessage::from).collect(),
        };
        let old = json!({ "messages": chunk.iter().map(|stored| json!({
            "id": stored.source_message_id,
            "phone_iccid": stored.message.phone_iccid,
            "phone_number": stored.message.phone_number,
            "content": stored.message.content,
            "timestamp": stored.message.timestamp,
            "direction": stored.message.direction,
        })).collect::<Vec<_>>() });
        assert_eq!(text(&new), text(&old));
    }

    #[test]
    fn call_requests_match_the_old_json_bodies() {
        for from in [Some("+8613800138000"), None] {
            let new = IncomingCallRequest {
                from,
                iccid: &iccid(),
            };
            let old = json!({ "iccid": ICCID, "from": from });
            assert_eq!(text(&new), text(&old));
        }
        for call_id in [Some("call-1"), None] {
            let new = EndedCallRequest {
                call_id,
                iccid: &iccid(),
                reason: CallEndReason::RemoteHangup,
            };
            let old = json!({
                "call_id": call_id,
                "iccid": ICCID,
                "reason": "remote_hangup",
            });
            assert_eq!(text(&new), text(&old));
        }
        assert_eq!(
            text(&IncomingCallRequest {
                from: None,
                iccid: &Iccid::try_from("a").unwrap()
            }),
            r#"{"from":null,"iccid":"a"}"#
        );
    }

    #[test]
    fn upload_results_accept_every_status_and_default_retryable() {
        let response: UploadResponse = serde_json::from_value(json!({
            "results": [
                {"id": "a", "status": "stored"},
                {"id": "b", "status": "already_stored"},
                {"id": "c", "status": "rejected", "retryable": true},
                {"id": "d", "status": "something-new"},
            ]
        }))
        .unwrap();
        let statuses: Vec<_> = response.results.iter().map(|r| r.status.clone()).collect();
        assert_eq!(
            statuses,
            vec![
                UploadStatus::Stored,
                UploadStatus::AlreadyStored,
                UploadStatus::Rejected,
                UploadStatus::Unknown("something-new".to_string()),
            ]
        );
        assert!(!response.results[0].retryable);
        assert!(response.results[2].retryable);
    }

    #[test]
    fn serializes_confirmed_submission_without_an_error() {
        let result = SmsResult::new("message-1", Ok(SmsSubmission::Confirmed));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"message_id": "message-1", "outcome": "confirmed", "error_message": null})
        );
    }

    #[test]
    fn serializes_unconfirmed_submission_with_its_delivery_warning() {
        let result = SmsResult::new("message-1", Ok(SmsSubmission::SubmittedUnconfirmed));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "message_id": "message-1",
                "outcome": "submitted_unconfirmed",
                "error_message": "SMS body submitted; modem did not return a final confirmation"
            })
        );
    }

    #[test]
    fn serializes_failed_submission_with_its_error() {
        let result = SmsResult::new("message-1", Err("Modem not found"));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "message_id": "message-1",
                "outcome": "failed",
                "error_message": "Modem not found"
            })
        );
    }
}
