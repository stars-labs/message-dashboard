// Integration tests for SmsSender - Outbound SMS handling
mod support;

use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::identifiers::{Iccid, SmsAddress};
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::sms_sender::SmsSender;
use orange_pi_daemon_rust::types::{Config, SmsSubmission};
use orange_pi_daemon_rust::wire::{PendingSms, Purpose};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use support::{serve, Request};

// For tests that never reach the network.
fn create_test_sender() -> anyhow::Result<SmsSender> {
    sender_at("http://localhost:8787".to_string())
}

fn sender_at(api_url: String) -> anyhow::Result<SmsSender> {
    let config = Config {
        api_url,
        api_key: "test_key".into(),
        check_interval_secs: 1,
    };

    let api_client = ApiClient::new(config)?;
    let modem_manager = Arc::new(ModemManager::new());

    Ok(SmsSender::new(
        api_client,
        modem_manager,
        "test-session".to_string(),
    ))
}

#[expect(
    clippy::unwrap_used,
    reason = "test helper: clippy.toml allow-unwrap-in-tests covers only #[test] items"
)]
fn iccid(text: &str) -> Iccid {
    Iccid::try_from(text).unwrap()
}

// Helper function to create test pending SMS
fn create_test_sms(id: &str, iccid: &str, recipient: &str, content: &str) -> PendingSms {
    PendingSms {
        id: id.to_string(),
        recipient: SmsAddress::from(recipient),
        phone_iccid: iccid.to_string(),
        content: content.to_string(),
        purpose: Purpose::User,
        created_at: "2024-01-01T12:00:00.000Z".to_string(),
    }
}

// ============================================================================
// Construction Tests
// ============================================================================

#[tokio::test]
async fn test_sms_sender_new() {
    let mut sender = create_test_sender().unwrap();
    sender.update_modem_cache(HashMap::from([(
        iccid("89860000000000000010"),
        "modem".to_string(),
    )]));
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000010"))
            .await
            .as_deref(),
        Some("modem")
    );
}

// ============================================================================
// Modem Cache Tests
// ============================================================================

#[tokio::test]
async fn test_update_modem_cache() {
    let mut sender = create_test_sender().unwrap();

    let mut cache = HashMap::new();
    cache.insert(iccid("89860000000000000001"), "modem_0".to_string());
    cache.insert(iccid("89860000000000000002"), "modem_1".to_string());

    sender.update_modem_cache(cache);

    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000001"))
            .await
            .as_deref(),
        Some("modem_0")
    );
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000002"))
            .await
            .as_deref(),
        Some("modem_1")
    );
}

#[tokio::test]
async fn test_update_modem_cache_empty() {
    let mut sender = create_test_sender().unwrap();

    sender.update_modem_cache(HashMap::from([(
        iccid("89860000000000000010"),
        "modem".to_string(),
    )]));
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000010"))
            .await
            .as_deref(),
        Some("modem")
    );
    sender.update_modem_cache(HashMap::new());
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000010"))
            .await,
        None
    );
}

#[tokio::test]
async fn test_update_modem_cache_multiple_times() {
    let mut sender = create_test_sender().unwrap();

    // First update
    let mut cache1 = HashMap::new();
    cache1.insert(iccid("89860000000000000001"), "modem_0".to_string());
    sender.update_modem_cache(cache1);

    // Second update (replaces first)
    let mut cache2 = HashMap::new();
    cache2.insert(iccid("89860000000000000002"), "modem_1".to_string());
    sender.update_modem_cache(cache2);

    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000002"))
            .await
            .as_deref(),
        Some("modem_1")
    );
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000001"))
            .await,
        None
    );
}

// ============================================================================
// Find Modem for ICCID Tests
// ============================================================================

#[tokio::test]
async fn test_find_modem_for_iccid_from_cache() {
    let mut sender = create_test_sender().unwrap();

    // Populate cache
    let mut cache = HashMap::new();
    cache.insert(iccid("89860000000000000011"), "modem_0".to_string());
    sender.update_modem_cache(cache);

    // Find modem using cached ICCID
    let result = sender
        .find_modem_for_iccid(&iccid("89860000000000000011"))
        .await;

    // Should find modem in cache
    assert_eq!(result, Some("modem_0".to_string()));
}

#[tokio::test]
async fn test_find_modem_for_iccid_not_in_cache() {
    let sender = create_test_sender().unwrap();

    // Try to find modem not in cache (will search via modem manager)
    let result = sender
        .find_modem_for_iccid(&iccid("89860000000000000012"))
        .await;

    // Should return None (no real hardware)
    assert_eq!(result, None);
}

#[tokio::test]
async fn test_find_modem_for_iccid_cache_hit_vs_miss() {
    let mut sender = create_test_sender().unwrap();

    // Populate cache with one ICCID
    let mut cache = HashMap::new();
    cache.insert(iccid("89860000000000000013"), "modem_0".to_string());
    sender.update_modem_cache(cache);

    // Test cache hit
    let cached_result = sender
        .find_modem_for_iccid(&iccid("89860000000000000013"))
        .await;
    assert_eq!(cached_result, Some("modem_0".to_string()));

    // Test cache miss
    let uncached_result = sender
        .find_modem_for_iccid(&iccid("89860000000000000014"))
        .await;
    assert_eq!(uncached_result, None);
}

// ============================================================================
// PendingSms Data Structure Tests
// ============================================================================

#[test]
fn test_pending_sms_creation() {
    let sms = create_test_sms("msg_001", "89860000000000000001", "+1234567890", "Hello");

    assert_eq!(sms.id, "msg_001");
    assert_eq!(sms.phone_iccid, "89860000000000000001");
    assert_eq!(sms.recipient.as_str(), "+1234567890");
    assert_eq!(sms.content, "Hello");
}

#[test]
fn test_pending_sms_clone() {
    let sms = create_test_sms("msg_001", "89860000000000000001", "+1234567890", "Test");

    // PendingSms implements Clone
    let cloned = sms.clone();

    assert_eq!(sms.id, cloned.id);
    assert_eq!(sms.phone_iccid, cloned.phone_iccid);
    assert_eq!(sms.content, cloned.content);
}

#[test]
fn test_pending_sms_debug() {
    let sms = create_test_sms("msg_001", "89860000000000000001", "+1234567890", "Test");

    // PendingSms implements Debug
    let debug_str = format!("{sms:?}");

    assert!(debug_str.contains("msg_001"));
    assert!(debug_str.contains("89860000000000000001"));
}

// ============================================================================
// Send SMS Tests (Signature Testing)
// ============================================================================

const REPORTED: &str = r#"{"success": true}"#;

#[expect(
    clippy::unwrap_used,
    reason = "test helper: clippy.toml allow-unwrap-in-tests covers only #[test] items"
)]
fn reported(request: &Request) -> Value {
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/api/control/sms-result")
    );
    assert_eq!(request.header("x-api-key"), Some("test_key"));
    serde_json::from_str(&request.body).unwrap()
}

#[tokio::test]
async fn send_without_a_modem_for_the_iccid_reports_the_failure() {
    let sms = create_test_sms("msg_001", "89860000000000000001", "+1234567890", "Test");
    let (result, requests) = serve(&[("200 OK", REPORTED.into())], |url| async move {
        sender_at(url).unwrap().send_sms(&sms).await
    })
    .await
    .unwrap();

    assert_eq!(result.unwrap_err().to_string(), "ModemNotFound");
    assert_eq!(
        reported(&requests[0]),
        json!({"message_id": "msg_001", "outcome": "failed", "error_message": "No modem found for ICCID"})
    );
}

#[tokio::test]
async fn test_send_sms_for_an_iccid_no_modem_can_hold_is_a_modem_not_found_error() {
    let phone_iccids = ["fixture-iccid", "", "8986 0000", "89860000000000000011\n"];
    let replies = phone_iccids.map(|_| ("200 OK", REPORTED.to_string()));
    let (errors, requests) = serve(&replies, |url| async move {
        let mut sender = sender_at(url).unwrap();
        sender.update_modem_cache(HashMap::from([(
            iccid("89860000000000000011"),
            "modem_0".to_string(),
        )]));
        let mut errors = Vec::new();
        for phone_iccid in phone_iccids {
            let sms = create_test_sms("msg_001", phone_iccid, "+1234567890", "Test");
            errors.push(sender.send_sms(&sms).await.unwrap_err().to_string());
        }
        errors
    })
    .await
    .unwrap();

    assert_eq!(errors, phone_iccids.map(|_| "ModemNotFound"));
    for request in &requests {
        assert_eq!(reported(request)["outcome"], "failed");
    }
}

#[tokio::test]
async fn send_that_the_modem_refuses_reports_the_modem_error() {
    let sms = create_test_sms("msg_001", "89860000000000000011", "+1234567890", "Test");
    let (result, requests) = serve(&[("200 OK", REPORTED.into())], |url| async move {
        let mut sender = sender_at(url).unwrap();
        sender.update_modem_cache(HashMap::from([(
            iccid("89860000000000000011"),
            "modem_0".to_string(),
        )]));
        sender.send_sms(&sms).await
    })
    .await
    .unwrap();

    let error = result.unwrap_err().to_string();
    assert!(error.starts_with("Failed to send SMS: "), "{error}");
    let body = reported(&requests[0]);
    assert_eq!(body["outcome"], "failed");
    assert_eq!(body["error_message"], error);
}

#[tokio::test]
async fn a_rejected_result_report_keeps_the_status_and_body() {
    let (result, requests) = serve(
        &[("500 Internal Server Error", "boom".into())],
        |url| async move {
            sender_at(url)
                .unwrap()
                .report_sms_result("msg_001", Ok(SmsSubmission::Confirmed))
                .await
        },
    )
    .await
    .unwrap();

    assert_eq!(reported(&requests[0])["outcome"], "confirmed");
    assert_eq!(
        result.unwrap_err().to_string(),
        "Failed to report SMS result: 500 Internal Server Error - boom"
    );
}

#[tokio::test]
async fn processing_sends_each_pending_message_and_reports_it() {
    let pending = json!({"pending_messages": [{
        "id": "msg_001",
        "recipient": "+1234567890",
        "phone_iccid": "89860000000000000001",
        "content": "Test",
        "purpose": "user",
        "created_at": "2026-11-25T00:00:00.000Z"
    }]});
    let replies = [
        ("200 OK", pending.to_string()),
        ("200 OK", REPORTED.to_string()),
    ];
    let (result, requests) = serve(&replies, |url| async move {
        sender_at(url).unwrap().process_pending_sms().await
    })
    .await
    .unwrap();

    result.unwrap();
    assert_eq!(
        (requests[0].method.as_str(), requests[0].path.as_str()),
        ("GET", "/api/control/pending-sms")
    );
    assert_eq!(
        requests[0].header("x-daemon-session-id"),
        Some("test-session")
    );
    assert_eq!(reported(&requests[1])["message_id"], "msg_001");
}

#[tokio::test]
async fn processing_nothing_pending_sends_nothing_else() {
    let (result, requests) = serve(
        &[("200 OK", r#"{"pending_messages": []}"#.into())],
        |url| async move { sender_at(url).unwrap().process_pending_sms().await },
    )
    .await
    .unwrap();

    result.unwrap();
    assert_eq!(requests.len(), 1);
}

// ============================================================================
// Edge Cases
// ============================================================================

#[test]
fn test_pending_sms_with_empty_content() {
    let sms = create_test_sms("msg_001", "89860000000000000001", "+1234567890", "");

    assert_eq!(sms.content, "");
}

#[test]
fn test_pending_sms_with_long_content() {
    let long_content = "x".repeat(1000);
    let sms = create_test_sms(
        "msg_001",
        "89860000000000000001",
        "+1234567890",
        &long_content,
    );

    assert_eq!(sms.content.len(), 1000);
}

#[test]
fn test_pending_sms_with_special_characters() {
    let sms = create_test_sms(
        "msg_001",
        "89860000000000000001",
        "+1234567890",
        "你好 Hello 🌍 'quotes\" <tags>",
    );

    assert!(sms.content.contains("你好"));
    assert!(sms.content.contains("🌍"));
}

#[test]
fn test_pending_sms_with_international_number() {
    let sms = create_test_sms("msg_001", "89860000000000000001", "+8613800138000", "测试");

    assert_eq!(sms.recipient.as_str(), "+8613800138000");
    assert_eq!(sms.content, "测试");
}

// ============================================================================
// Cache Management Tests
// ============================================================================

#[tokio::test]
async fn test_modem_cache_large_scale() {
    let mut sender = create_test_sender().unwrap();

    // Create cache with 100+ modems (simulating production)
    let mut cache = HashMap::new();
    for i in 0..100 {
        cache.insert(
            iccid(&format!("8986000000000000{i:04}")),
            format!("modem_{i}"),
        );
    }

    sender.update_modem_cache(cache);

    for i in 0..100 {
        assert_eq!(
            sender
                .find_modem_for_iccid(&iccid(&format!("8986000000000000{i:04}")))
                .await,
            Some(format!("modem_{i}"))
        );
    }
}

#[tokio::test]
async fn test_find_modem_multiple_lookups() {
    let mut sender = create_test_sender().unwrap();

    let mut cache = HashMap::new();
    cache.insert(iccid("89860000000000000001"), "modem_0".to_string());
    cache.insert(iccid("89860000000000000002"), "modem_1".to_string());
    cache.insert(iccid("89860000000000000003"), "modem_2".to_string());
    sender.update_modem_cache(cache);

    // Perform multiple lookups
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000001"))
            .await,
        Some("modem_0".to_string())
    );
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000002"))
            .await,
        Some("modem_1".to_string())
    );
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000003"))
            .await,
        Some("modem_2".to_string())
    );
    assert_eq!(
        sender
            .find_modem_for_iccid(&iccid("89860000000000000999"))
            .await,
        None
    );
}
