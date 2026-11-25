// The daemon's side of the control-route fixtures the Worker is replayed against
// (sms-dashboard/server/control-fixtures.test.ts): every body the daemon sends
// must serialize to the recorded request, and every answer it reads must parse.
use orange_pi_daemon_rust::identifiers::{Iccid, Imei, SimNumber, SmsAddress};
use orange_pi_daemon_rust::message_store::StoredMessage;
use orange_pi_daemon_rust::types::{Message, SmsSubmission};
use orange_pi_daemon_rust::wire::{
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
            "../../sms-dashboard/shared/control-fixtures/daemon/",
            $name,
            ".json"
        )))
        .unwrap()
    };
}

const ICCID: &str = "89860123456789012345";

#[expect(
    clippy::unwrap_used,
    reason = "test helper: clippy.toml allow-unwrap-in-tests covers only #[test] items"
)]
fn iccid() -> Iccid {
    Iccid::try_from(ICCID).unwrap()
}

#[expect(
    clippy::unwrap_used,
    reason = "test helper: clippy.toml allow-unwrap-in-tests covers only #[test] items"
)]
fn assert_sends(fixture: &Fixture, body: &impl Serialize) {
    assert_eq!(serde_json::to_value(body).unwrap(), fixture.request.body);
}

#[expect(
    clippy::unwrap_used,
    reason = "test helper: clippy.toml allow-unwrap-in-tests covers only #[test] items"
)]
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
