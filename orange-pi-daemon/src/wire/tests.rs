use super::*;
use crate::message_store::StoredMessage;
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
    assert!(ts_of::<HealthSnapshot>().contains(&format!("schema_version: {HEALTH_SCHEMA_VERSION}")));
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
        source_message_id: "source-1".to_string(),
        message: Message {
            phone_iccid: iccid(),
            phone_number: SmsAddress::from("+1234567890"),
            content: "code 123456".to_string(),
            timestamp: "2026-01-02T03:04:05.678Z".to_string(),
            direction: Direction::Received,
        },
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

// The daemon's side of the control-route fixtures the Worker is replayed against
// (sms-dashboard/server/control-fixtures.test.ts): every body the daemon sends
// must serialize to the recorded request, and every answer it reads must parse.
mod control_fixtures {
    use crate::identifiers::{Iccid, Imei, SimNumber, SmsAddress};
    use crate::message_store::StoredMessage;
    use crate::types::{Message, SmsSubmission};
    use crate::wire::{
        CallEndReason, Direction, EndedCallRequest, HealthSnapshot, IncomingCallRequest,
        MessageBatchRequest, ModemReport, ModemReportsRequest, ModemStatus, PendingSmsResponse,
        Purpose, QueueHealthSnapshot, SmsResult, SyncMode, UploadResponse, UploadStatus,
        UploadedMessage,
    };
    use serde::de::DeserializeOwned;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    #[derive(Deserialize)]
    struct Fixture {
        request: Request,
        response: Response,
    }

    #[derive(Deserialize)]
    struct Request {
        #[serde(default)]
        body: Value,
    }

    #[derive(Deserialize)]
    struct Response {
        status: u16,
        #[serde(default)]
        body: Value,
    }

    macro_rules! fixture {
        ($name:literal) => {
            serde_json::from_str::<Fixture>(include_str!(concat!(
                "../../../sms-dashboard/shared/control-fixtures/daemon/",
                $name,
                ".json"
            )))
            .unwrap()
        };
    }

    const ICCID: &str = "89860123456789012345";

    fn iccid() -> Iccid {
        Iccid::try_from(ICCID).unwrap()
    }

    fn assert_sends(fixture: &Fixture, body: &impl Serialize) {
        assert_eq!(serde_json::to_value(body).unwrap(), fixture.request.body);
    }

    fn answer<T: DeserializeOwned>(fixture: &Fixture) -> T {
        serde_json::from_value(fixture.response.body.clone()).unwrap()
    }

    #[test]
    fn heartbeat_sends_the_recorded_health_snapshot() {
        let snapshot = HealthSnapshot {
            schema_version: 3,
            session_id: "daemon-session-1".to_string(),
            version: "8.0.1".to_string(),
            uptime_seconds: 3600,
            last_message_read_success_age_seconds: Some(5),
            last_upload_success_age_seconds: Some(10),
            queue: QueueHealthSnapshot {
                pending: 0,
                in_flight: 0,
                dead_letter: 0,
                oldest_unacknowledged_age_seconds: None,
            },
        };
        assert_sends(&fixture!("heartbeat"), &snapshot);
    }

    #[test]
    fn devices_sends_the_recorded_modem_reports() {
        let reports = [ModemReport {
            detected_iccid: Some(iccid()),
            detected_operator: Some("China Mobile".to_string()),
            detected_phone_number: Some(SimNumber::try_from("+8613800000001").unwrap()),
            equipment_id: Imei::try_from("861234567890123").unwrap(),
            firmware_revision: Some("EC20CEFAG".to_string()),
            hardware_revision: None,
            manufacturer: Some("Quectel".to_string()),
            model: Some("EC20".to_string()),
            modem_index: Some(0),
            rssi: Some(-60),
            signal_percent: Some(75),
            status: ModemStatus::Connected,
            usb_path: Some("1-1.2".to_string()),
            usb_port: Some(2),
        }];
        let request = ModemReportsRequest {
            modem_reports: &reports,
            removed_equipment_ids: &[],
            session_id: "daemon-session-1",
            sync_mode: SyncMode::Full,
            timestamp: "2026-11-15T00:00:00.000Z",
        };
        assert_sends(&fixture!("devices"), &request);
    }

    #[test]
    fn messages_sends_the_recorded_batch_and_reads_each_result() {
        let fixture = fixture!("messages");
        let stored = StoredMessage {
            source_message_id: "018c1a55-73a0-7b9b-8c06-123456789abc".to_string(),
            message: Message {
                phone_iccid: iccid(),
                phone_number: SmsAddress::from("+8610086"),
                content: "Your code is 123456".to_string(),
                timestamp: "2026-11-15T00:00:00.000Z".to_string(),
                direction: Direction::Received,
            },
            attempts: 0,
            lease_token: "lease-1".to_string(),
        };
        let batch = MessageBatchRequest {
            messages: vec![UploadedMessage::from(&stored)],
        };
        assert_sends(&fixture, &batch);

        let response: UploadResponse = answer(&fixture);
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].id, stored.source_message_id);
        assert_eq!(response.results[0].status, UploadStatus::Stored);
        assert!(!response.results[0].retryable);
    }

    #[test]
    fn pending_sms_reads_the_recorded_queue() {
        let empty: PendingSmsResponse = answer(&fixture!("pending-sms.empty"));
        assert!(empty.pending_messages.is_empty());

        let queued: PendingSmsResponse = answer(&fixture!("pending-sms"));
        assert_eq!(queued.pending_messages.len(), 1);
        let sms = &queued.pending_messages[0];
        assert_eq!(sms.id, "outbound-1");
        assert_eq!(sms.recipient, SmsAddress::from("+8613900000002"));
        assert_eq!(sms.phone_iccid, ICCID);
        assert_eq!(sms.content, "hello");
        assert_eq!(sms.purpose, Purpose::User);
        assert_eq!(sms.created_at, "2026-11-14 23:00:00");
    }

    #[test]
    fn sms_result_sends_the_recorded_outcome() {
        let result = SmsResult::new("outbound-1", Ok(SmsSubmission::Confirmed));
        assert_sends(&fixture!("sms-result"), &result);
    }

    #[test]
    fn incoming_call_sends_the_recorded_ring_and_expects_409_when_busy() {
        let iccid = iccid();
        let ring = IncomingCallRequest {
            from: Some("+8613900000002"),
            iccid: &iccid,
        };
        assert_sends(&fixture!("calls-incoming"), &ring);

        let busy = fixture!("calls-incoming.busy");
        assert_sends(&busy, &ring);
        assert_eq!(busy.response.status, 409);
    }

    #[test]
    fn ended_call_sends_the_recorded_end() {
        let iccid = iccid();
        let ended = EndedCallRequest {
            call_id: Some("call-1"),
            iccid: &iccid,
            reason: CallEndReason::RemoteHangup,
        };
        assert_sends(&fixture!("calls-ended"), &ended);
    }
}
