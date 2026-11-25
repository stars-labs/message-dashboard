// Integration tests for ApiClient - HTTP communication layer
mod support;

use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::identifiers::{Iccid, Imei, SmsAddress};
use orange_pi_daemon_rust::message_store::StoredMessage;
use orange_pi_daemon_rust::types::{Config, Message};
use orange_pi_daemon_rust::wire::{
    CallEndReason, Direction, HealthSnapshot, ModemReport, QueueHealthSnapshot, SyncMode,
};
use serde_json::Value;
use support::serve;

const API_KEY: &str = "test_api_key_12345";

// Helper function to create test config
fn create_test_config() -> Config {
    Config {
        api_url: "http://localhost:8787".to_string(),
        api_key: API_KEY.into(),
    }
}

#[expect(
    clippy::unwrap_used,
    reason = "test helper: clippy.toml allow-unwrap-in-tests covers only #[test] items"
)]
fn client_for(api_url: String) -> ApiClient {
    ApiClient::new(Config {
        api_url,
        api_key: API_KEY.into(),
    })
    .unwrap()
}

// Helper function to create test message
#[expect(
    clippy::unwrap_used,
    reason = "test helper: clippy.toml allow-unwrap-in-tests covers only #[test] items"
)]
fn create_test_message(iccid: &str, content: &str) -> Message {
    Message {
        phone_iccid: Iccid::try_from(iccid).unwrap(),
        phone_number: SmsAddress::from("+1234567890"),
        content: content.to_string(),
        timestamp: "2024-01-01T12:00:00.000Z".to_string(),
        direction: Direction::Received,
    }
}

fn create_stored_test_message(iccid: &str, content: &str) -> StoredMessage {
    StoredMessage {
        source_message_id: "018c1a55-73a0-7b9b-8c06-123456789abc".to_string(),
        message: create_test_message(iccid, content),
        attempts: 0,
        lease_token: "lease-1".to_string(),
    }
}

// ============================================================================
// Construction Tests
// ============================================================================

#[test]
fn test_api_client_new() {
    let config = create_test_config();
    let client = ApiClient::new(config.clone()).unwrap();

    // Verify config is stored
    assert_eq!(client.config.api_url, config.api_url);
    assert_eq!(client.config.api_key, config.api_key);
}

#[test]
fn test_api_client_clone() {
    let config = create_test_config();
    let client = ApiClient::new(config).unwrap();

    // ApiClient implements Clone
    let cloned = client.clone();

    assert_eq!(client.config.api_url, cloned.config.api_url);
    assert_eq!(client.config.api_key, cloned.config.api_key);
}

#[tokio::test]
async fn test_empty_incremental_device_delta_is_a_noop() {
    let client = ApiClient::new(create_test_config()).unwrap();
    let reports: Vec<ModemReport> = Vec::new();
    let removed: Vec<Imei> = Vec::new();

    let result = client
        .upload_modem_reports(&reports, &removed, SyncMode::Incremental, "session")
        .await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_empty_full_device_snapshot_reaches_the_reconciliation_endpoint() {
    let (result, requests) = serve(&[("200 OK", "{}".into())], |url| async move {
        client_for(url)
            .upload_modem_reports(&[], &[], SyncMode::Full, "session")
            .await
    })
    .await
    .unwrap();

    result.unwrap();
    let [request] = requests.as_slice() else {
        panic!("expected one request, got {requests:?}")
    };
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/api/control/devices")
    );
    assert_eq!(request.header("x-api-key"), Some(API_KEY));
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["sync_mode"], "full");
    assert_eq!(body["modem_reports"], Value::Array(vec![]));
}

#[tokio::test]
async fn device_upload_error_keeps_the_status_and_body() {
    let (result, _) = serve(
        &[("500 Internal Server Error", "boom".into())],
        |url| async move {
            client_for(url)
                .upload_modem_reports(&[], &[], SyncMode::Full, "session")
                .await
        },
    )
    .await
    .unwrap();

    assert_eq!(
        result.unwrap_err().to_string(),
        "API returned error: 500 Internal Server Error - boom"
    );
}

// ============================================================================
// Heartbeat Tests
// ============================================================================

fn health_snapshot() -> HealthSnapshot {
    HealthSnapshot {
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
    }
}

#[tokio::test]
async fn health_snapshot_carries_the_key_and_the_daemon_version() {
    let (result, requests) = serve(&[("200 OK", "{}".into())], |url| async move {
        client_for(url)
            .send_health_snapshot(&health_snapshot())
            .await
    })
    .await
    .unwrap();

    result.unwrap();
    let [request] = requests.as_slice() else {
        panic!("expected one request, got {requests:?}")
    };
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/api/control/heartbeat")
    );
    assert_eq!(request.header("x-api-key"), Some(API_KEY));
    assert_eq!(
        request.header("x-daemon-version"),
        Some(env!("CARGO_PKG_VERSION"))
    );
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["schema_version"], 3);
}

#[tokio::test]
async fn health_snapshot_error_keeps_the_status_and_body() {
    let (result, _) = serve(&[("401 Unauthorized", "no key".into())], |url| async move {
        client_for(url)
            .send_health_snapshot(&health_snapshot())
            .await
    })
    .await
    .unwrap();

    assert_eq!(
        result.unwrap_err().to_string(),
        "Health endpoint returned 401 Unauthorized: no key"
    );
}

// ============================================================================
// Upload Messages Tests
// ============================================================================

#[tokio::test]
async fn test_upload_messages_empty() {
    let config = create_test_config();
    let client = ApiClient::new(config).unwrap();

    let messages: Vec<StoredMessage> = vec![];

    // Empty upload should succeed immediately
    let result = client.upload_messages(&messages).await;

    assert!(result.is_ok());
}

fn stored_messages(count: usize) -> Vec<StoredMessage> {
    (0..count)
        .map(|i| create_stored_test_message("89860000000000000001", &format!("Message {i}")))
        .collect()
}

fn stored(id: &str) -> String {
    format!(r#"{{"results": [{{"id": "{id}", "status": "stored"}}]}}"#)
}

#[tokio::test]
async fn upload_sends_batches_of_fifty_and_collects_every_result() {
    let messages = stored_messages(120);
    let replies = [
        ("200 OK", stored("a")),
        ("200 OK", stored("b")),
        ("200 OK", stored("c")),
    ];
    let (results, requests) = serve(&replies, |url| async move {
        client_for(url).upload_messages(&messages).await
    })
    .await
    .unwrap();

    let ids: Vec<String> = results.unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, ["a", "b", "c"]);
    let sizes: Vec<usize> = requests
        .iter()
        .map(|request| {
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("POST", "/api/control/messages")
            );
            assert_eq!(request.header("x-api-key"), Some(API_KEY));
            let body: Value = serde_json::from_str(&request.body).unwrap();
            body["messages"].as_array().unwrap().len()
        })
        .collect();
    assert_eq!(sizes, [50, 50, 20]);
}

#[tokio::test]
async fn upload_error_names_the_failing_batch() {
    let messages = stored_messages(60);
    let replies = [
        ("200 OK", stored("a")),
        ("500 Internal Server Error", "boom".to_string()),
    ];
    let (result, requests) = serve(&replies, |url| async move {
        client_for(url).upload_messages(&messages).await
    })
    .await
    .unwrap();

    assert_eq!(requests.len(), 2);
    assert_eq!(
        result.unwrap_err().to_string(),
        "API returned error for batch 2: 500 Internal Server Error - boom"
    );
}

#[tokio::test]
async fn upload_refuses_an_answer_it_cannot_read() {
    let messages = stored_messages(1);
    let (result, _) = serve(&[("200 OK", "not json".into())], |url| async move {
        client_for(url).upload_messages(&messages).await
    })
    .await
    .unwrap();

    assert_eq!(
        result.unwrap_err().to_string(),
        "Invalid message upload response"
    );
}

// ============================================================================
// Call Event Tests
// ============================================================================

#[tokio::test]
async fn incoming_call_accepts_success_and_a_busy_line() {
    let iccid = Iccid::try_from("89860000000000000001").unwrap();
    let replies = [("200 OK", "{}".into()), ("409 Conflict", "{}".into())];
    let (results, requests) = serve(&replies, |url| async move {
        let client = client_for(url);
        (
            client
                .report_incoming_call(&iccid, Some("+6590000000"))
                .await,
            client.report_incoming_call(&iccid, None).await,
        )
    })
    .await
    .unwrap();

    results.0.unwrap();
    results.1.unwrap();
    assert_eq!(requests[0].path, "/api/control/calls/incoming");
    let body: Value = serde_json::from_str(&requests[0].body).unwrap();
    assert_eq!(body["from"], "+6590000000");
    assert_eq!(body["iccid"], "89860000000000000001");
}

#[tokio::test]
async fn ended_call_error_names_the_event() {
    let iccid = Iccid::try_from("89860000000000000001").unwrap();
    let (result, requests) = serve(
        &[("500 Internal Server Error", "boom".into())],
        |url| async move {
            client_for(url)
                .report_call_ended(Some("call-1"), &iccid, CallEndReason::RemoteHangup)
                .await
        },
    )
    .await
    .unwrap();

    assert_eq!(requests[0].path, "/api/control/calls/ended");
    assert_eq!(
        result.unwrap_err().to_string(),
        "calls/ended returned 500 Internal Server Error: boom"
    );
}

// ============================================================================
// Data Structure Tests
// ============================================================================

#[test]
fn test_config_structure() {
    let config = Config {
        api_url: "https://api.example.com".to_string(),
        api_key: "secret_key".into(),
    };

    assert_eq!(config.api_url, "https://api.example.com");
    assert_eq!(config.api_key.expose(), "secret_key");
}

#[test]
fn test_message_structure() {
    let msg = create_test_message("89860000000000000001", "Hello");

    assert_eq!(msg.phone_iccid.as_str(), "89860000000000000001");
    assert_eq!(msg.content, "Hello");
    assert_eq!(msg.direction, Direction::Received);
}

// ============================================================================
// Sync Mode Tests
// ============================================================================

#[test]
fn test_sync_mode_full() {
    let mode = SyncMode::Full;
    assert_eq!(mode.as_str(), "full");
}

#[test]
fn test_sync_mode_incremental() {
    let mode = SyncMode::Incremental;
    assert_eq!(mode.as_str(), "incremental");
}

// ============================================================================
// Edge Cases
// ============================================================================

#[test]
fn test_message_with_empty_content() {
    let msg = create_test_message("89860000000000000001", "");
    assert_eq!(msg.content, "");
}

#[test]
fn test_message_with_long_content() {
    let long_content = "x".repeat(1000);
    let msg = create_test_message("89860000000000000001", &long_content);
    assert_eq!(msg.content.len(), 1000);
}

#[test]
fn test_message_with_unicode() {
    let msg = create_test_message("89860000000000000001", "你好世界 Hello 🌍");
    assert!(msg.content.contains("你好"));
    assert!(msg.content.contains("🌍"));
}

// ============================================================================
// Configuration Edge Cases
// ============================================================================

#[test]
fn test_config_with_custom_url() {
    let config = Config {
        api_url: "https://custom.api.com:8443".to_string(),
        api_key: "key".into(),
    };

    let client = ApiClient::new(config).unwrap();
    assert!(client.config.api_url.contains("8443"));
}

#[test]
fn test_config_with_long_api_key() {
    let long_key = "x".repeat(256);
    let config = Config {
        api_url: "http://localhost".to_string(),
        api_key: long_key.into(),
    };

    let client = ApiClient::new(config).unwrap();
    assert_eq!(client.config.api_key.expose().len(), 256);
}
