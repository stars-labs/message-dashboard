use anyhow::Context;
use orange_pi_daemon_rust::types::Config;
use orange_pi_daemon_rust::types::{PendingSms, Purpose, SmsSubmission};
use orange_pi_daemon_rust::{
    api_client::ApiClient, modem_manager::ModemManager, sms_sender::SmsSender,
};
use serde_json::json;
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

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

// One bounded, in-process HTTP exchange; no server task outlives the test.
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
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let client = ApiClient::new(Config {
        api_url: format!("http://{address}"),
        api_key: "fixture-api-key".into(),
        check_interval_secs: 1,
    })?;
    let serve = async {
        let (mut stream, _) = listener.accept().await?;
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut chunk = [0; 1024];
            let count = stream.read(&mut chunk).await?;
            assert!(
                count > 0,
                "connection closed before request headers arrived"
            );
            request.extend_from_slice(
                chunk
                    .get(..count)
                    .context("read more bytes than the buffer holds")?,
            );
            assert!(
                request.len() <= 8192,
                "request headers exceeded fixture limit"
            );
        }
        let request = String::from_utf8(request)?.to_ascii_lowercase();
        assert!(request.starts_with("get /api/control/pending-sms http/1.1\r\n"));
        assert!(request.contains("x-api-key: fixture-api-key\r\n"));
        match expected_session {
            Some(session) => {
                assert!(request.contains(&format!("x-daemon-session-id: {session}\r\n")));
            }
            None => assert!(!request.contains("x-daemon-session-id:")),
        }
        let body = body.to_string();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await?;
        anyhow::Ok(())
    };
    let (served, result) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(serve, fetch(client))
    })
    .await
    .context("fixture HTTP exchange timed out")?;
    served?;
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

    assert_eq!(sms.recipient, "10010");
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
    assert_eq!(messages[0].recipient, "+8613800138000");
    assert_eq!(messages[0].content, "Hello");
    assert_eq!(messages[1].purpose, Purpose::BalanceMaintenance);
    assert_eq!(messages[1].recipient, "10010");
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
