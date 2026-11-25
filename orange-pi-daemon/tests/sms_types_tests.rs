mod support;

use orange_pi_daemon_rust::types::Config;
use orange_pi_daemon_rust::types::SmsSubmission;
use orange_pi_daemon_rust::wire::{PendingSms, Purpose};
use orange_pi_daemon_rust::{
    api_client::ApiClient, modem_manager::ModemManager, sms_sender::SmsSender,
};
use serde_json::json;
use std::{future::Future, sync::Arc};
use support::serve;

fn pending_payload() -> serde_json::Value {
    json!({
        "id": "09d64494-669b-47ee-9bd3-d2ea5de0f157",
        "recipient": "10010",
        "phone_iccid": "89860121750097854321",
        "content": "CXLL",
        "purpose": "balance_maintenance",
        "created_at": "2026-11-12T12:00:00.000Z"
    })
}

async fn with_pending_response<F, Fut>(
    status: &str,
    body: serde_json::Value,
    expected_session: Option<&str>,
    fetch: F,
) -> anyhow::Result<Vec<PendingSms>>
where
    F: FnOnce(ApiClient) -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<PendingSms>>>,
{
    let (result, requests) = serve(&[(status, body.to_string())], |api_url| async move {
        fetch(ApiClient::new(Config {
            api_url,
            api_key: "fixture-api-key".into(),
            check_interval_secs: 1,
        })?)
        .await
    })
    .await?;
    let [request] = requests.as_slice() else {
        anyhow::bail!("expected one request, got {requests:?}");
    };
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/api/control/pending-sms")
    );
    assert_eq!(request.header("x-api-key"), Some("fixture-api-key"));
    assert_eq!(request.header("x-daemon-session-id"), expected_session);
    assert!(request.body.is_empty());
    result
}

#[tokio::test]
async fn api_client_decodes_the_shared_pending_sms_model() {
    let messages = with_pending_response(
        "200 OK",
        json!({"pending_messages": [pending_payload()]}),
        None,
        |client| async move { client.get_pending_sms().await },
    )
    .await
    .unwrap();

    assert_eq!(messages.len(), 1);
    assert_eq!(
        serde_json::to_value(&messages[0]).unwrap(),
        pending_payload()
    );
}

#[tokio::test]
async fn sender_uses_the_shared_pending_sms_model_and_claiming_session() {
    let messages = with_pending_response(
        "200 OK",
        json!({"pending_messages": [pending_payload()]}),
        Some("fixture-session"),
        |client| async move {
            let sender = SmsSender::new(
                client,
                Arc::new(ModemManager::new().await),
                "fixture-session".into(),
            );
            sender.get_pending_sms().await
        },
    )
    .await
    .unwrap();

    assert_eq!(messages.len(), 1);
    assert_eq!(
        serde_json::to_value(&messages[0]).unwrap(),
        pending_payload()
    );
}

#[test]
fn pending_sms_recipient_and_iccid_keep_any_text_the_worker_sends() {
    for recipient in ["10010", "+6591234567", "Singtel", "DBS", "", "你好"] {
        let mut payload = pending_payload();
        payload["recipient"] = json!(recipient);
        payload["phone_iccid"] = json!("not-a-hex-iccid");
        let sms: PendingSms = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(sms.recipient.as_str(), recipient);
        assert_eq!(sms.phone_iccid, "not-a-hex-iccid");
        assert_eq!(serde_json::to_value(&sms).unwrap(), payload);
    }
}

#[tokio::test]
async fn pending_sms_client_rejects_obsolete_payloads_at_the_api_boundary() {
    let result = with_pending_response(
        "200 OK",
        json!({"pending_messages": [{"id": 42, "message": "CXLL", "recipient": "10010", "phone_iccid": "fixture-iccid"}]}),
        None,
        |client| async move { client.get_pending_sms().await },
    ).await;

    assert!(result
        .unwrap_err()
        .downcast_ref::<reqwest::Error>()
        .unwrap()
        .is_decode());
}

#[test]
fn submission_success_has_only_two_states() {
    fn describe(submission: SmsSubmission) -> &'static str {
        match submission {
            SmsSubmission::Confirmed => "confirmed",
            SmsSubmission::SubmittedUnconfirmed => "submitted_unconfirmed",
        }
    }

    assert_eq!(describe(SmsSubmission::Confirmed), "confirmed");
    assert_eq!(
        describe(SmsSubmission::SubmittedUnconfirmed),
        "submitted_unconfirmed"
    );
}

#[test]
fn pending_sms_accepts_the_workers_string_id_and_content_fields() {
    let sms: PendingSms = serde_json::from_value(pending_payload()).unwrap();

    assert_eq!(sms.recipient.as_str(), "10010");
    assert_eq!(sms.id, "09d64494-669b-47ee-9bd3-d2ea5de0f157");
    assert_eq!(sms.content, "CXLL");
    assert_eq!(sms.purpose, Purpose::BalanceMaintenance);
}

#[test]
fn pending_sms_requires_the_current_payload_fields() {
    for field in ["id", "recipient", "phone_iccid", "content", "created_at"] {
        let mut payload = pending_payload();
        payload.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<PendingSms>(payload).is_err(),
            "missing {field} must fail"
        );
    }
}

#[test]
fn missing_purpose_keeps_the_original_user_default() {
    let mut payload = pending_payload();
    payload.as_object_mut().unwrap().remove("purpose");
    let sms: PendingSms = serde_json::from_value(payload.clone()).unwrap();
    assert_eq!(sms.purpose, Purpose::User);
    payload["purpose"] = json!("user");
    assert_eq!(serde_json::to_value(sms).unwrap(), payload);
}

#[test]
fn explicit_null_purpose_is_still_rejected() {
    let mut payload = pending_payload();
    payload["purpose"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<PendingSms>(payload).is_err());
}

#[tokio::test]
async fn sender_keeps_the_entire_claimed_batch_when_one_purpose_is_missing() {
    let mut user = pending_payload();
    user["id"] = json!("ordinary-message");
    user["recipient"] = json!("+8613800138000");
    user["content"] = json!("Hello");
    user.as_object_mut().unwrap().remove("purpose");

    let messages = with_pending_response(
        "200 OK",
        json!({"pending_messages": [user, pending_payload()]}),
        Some("fixture-session"),
        |client| async move {
            let sender = SmsSender::new(
                client,
                Arc::new(ModemManager::new().await),
                "fixture-session".into(),
            );
            sender.get_pending_sms().await
        },
    )
    .await
    .unwrap();

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, "ordinary-message");
    assert_eq!(messages[0].purpose, Purpose::User);
    assert_eq!(messages[0].recipient.as_str(), "+8613800138000");
    assert_eq!(messages[0].content, "Hello");
    assert_eq!(messages[1].purpose, Purpose::BalanceMaintenance);
    assert_eq!(messages[1].recipient.as_str(), "10010");
    assert_eq!(messages[1].content, "CXLL");
}

#[tokio::test]
async fn sender_keeps_http_error_status_and_response_body() {
    let error = with_pending_response(
        "403 Forbidden",
        json!({"error": "fixture access denied"}),
        Some("fixture-session"),
        |client| async move {
            let sender = SmsSender::new(
                client,
                Arc::new(ModemManager::new().await),
                "fixture-session".into(),
            );
            sender.get_pending_sms().await
        },
    )
    .await
    .unwrap_err();

    assert_eq!(
        error.to_string(),
        "Failed to fetch pending SMS: 403 Forbidden - {\"error\":\"fixture access denied\"}"
    );
}

#[test]
fn pending_sms_rejects_the_obsolete_numeric_id_and_message_fields() {
    let result = serde_json::from_value::<PendingSms>(json!({
        "id": 42,
        "recipient": "10010",
        "phone_iccid": "89860121750097854321",
        "message": "CXLL"
    }));

    assert!(result.is_err());
}

#[test]
fn debug_output_never_contains_the_api_key() {
    let config = Config {
        api_url: "https://dashboard.example".into(),
        api_key: "fixture-api-key".into(),
        check_interval_secs: 1,
    };

    assert!(!format!("{config:?}").contains("fixture-api-key"));
}
