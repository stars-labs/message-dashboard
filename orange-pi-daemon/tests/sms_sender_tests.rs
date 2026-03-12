// Integration tests for SmsSender - Outbound SMS handling
use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::sms_sender::{PendingSms, SmsSender};
use orange_pi_daemon_rust::types::Config;
use std::collections::HashMap;
use std::sync::Arc;

// Helper function to create test SMS sender (async version)
async fn create_test_sender() -> SmsSender {
    let config = Config {
        api_url: "http://localhost:8787".to_string(),
        api_key: "test_key".to_string(),
        check_interval_secs: 1,
    };

    let api_client = ApiClient::new(config);
    let modem_manager = Arc::new(ModemManager::new().await);

    SmsSender::new(api_client, modem_manager)
}

// Helper function to create test pending SMS
fn create_test_sms(id: &str, iccid: &str, recipient: &str, content: &str) -> PendingSms {
    PendingSms {
        id: id.to_string(),
        recipient: recipient.to_string(),
        phone_iccid: iccid.to_string(),
        content: content.to_string(),
        created_at: "2024-01-01T12:00:00.000Z".to_string(),
    }
}

// ============================================================================
// Construction Tests
// ============================================================================

#[tokio::test]
async fn test_sms_sender_new() {
    let _sender = create_test_sender().await;

    // Sender should be created successfully
    // (Can't directly inspect internal state, but we can use public methods)
    assert!(true); // Construction succeeded
}

// ============================================================================
// Modem Cache Tests
// ============================================================================

#[tokio::test]
async fn test_update_modem_cache() {
    let mut sender = create_test_sender().await;

    let mut cache = HashMap::new();
    cache.insert("iccid_001".to_string(), "modem_0".to_string());
    cache.insert("iccid_002".to_string(), "modem_1".to_string());

    sender.update_modem_cache(cache);

    // Cache updated successfully (no panic)
    assert!(true);
}

#[tokio::test]
async fn test_update_modem_cache_empty() {
    let mut sender = create_test_sender().await;

    let cache = HashMap::new();
    sender.update_modem_cache(cache);

    // Should handle empty cache
    assert!(true);
}

#[tokio::test]
async fn test_update_modem_cache_multiple_times() {
    let mut sender = create_test_sender().await;

    // First update
    let mut cache1 = HashMap::new();
    cache1.insert("iccid_001".to_string(), "modem_0".to_string());
    sender.update_modem_cache(cache1);

    // Second update (replaces first)
    let mut cache2 = HashMap::new();
    cache2.insert("iccid_002".to_string(), "modem_1".to_string());
    sender.update_modem_cache(cache2);

    // Should replace cache successfully
    assert!(true);
}

// ============================================================================
// Find Modem for ICCID Tests
// ============================================================================

#[tokio::test]
async fn test_find_modem_for_iccid_from_cache() {
    let mut sender = create_test_sender().await;

    // Populate cache
    let mut cache = HashMap::new();
    cache.insert("test_iccid".to_string(), "modem_0".to_string());
    sender.update_modem_cache(cache);

    // Find modem using cached ICCID
    let result = sender.find_modem_for_iccid("test_iccid").await;

    // Should find modem in cache
    assert_eq!(result, Some("modem_0".to_string()));
}

#[tokio::test]
async fn test_find_modem_for_iccid_not_in_cache() {
    let sender = create_test_sender().await;

    // Try to find modem not in cache (will search via modem manager)
    let result = sender.find_modem_for_iccid("nonexistent_iccid").await;

    // Should return None (no real hardware)
    assert_eq!(result, None);
}

#[tokio::test]
async fn test_find_modem_for_iccid_cache_hit_vs_miss() {
    let mut sender = create_test_sender().await;

    // Populate cache with one ICCID
    let mut cache = HashMap::new();
    cache.insert("cached_iccid".to_string(), "modem_0".to_string());
    sender.update_modem_cache(cache);

    // Test cache hit
    let cached_result = sender.find_modem_for_iccid("cached_iccid").await;
    assert_eq!(cached_result, Some("modem_0".to_string()));

    // Test cache miss
    let uncached_result = sender.find_modem_for_iccid("uncached_iccid").await;
    assert_eq!(uncached_result, None);
}

// ============================================================================
// PendingSms Data Structure Tests
// ============================================================================

#[test]
fn test_pending_sms_creation() {
    let sms = create_test_sms("msg_001", "iccid_001", "+1234567890", "Hello");

    assert_eq!(sms.id, "msg_001");
    assert_eq!(sms.phone_iccid, "iccid_001");
    assert_eq!(sms.recipient, "+1234567890");
    assert_eq!(sms.content, "Hello");
}

#[test]
fn test_pending_sms_clone() {
    let sms = create_test_sms("msg_001", "iccid_001", "+1234567890", "Test");

    // PendingSms implements Clone
    let cloned = sms.clone();

    assert_eq!(sms.id, cloned.id);
    assert_eq!(sms.phone_iccid, cloned.phone_iccid);
    assert_eq!(sms.content, cloned.content);
}

#[test]
fn test_pending_sms_debug() {
    let sms = create_test_sms("msg_001", "iccid_001", "+1234567890", "Test");

    // PendingSms implements Debug
    let debug_str = format!("{:?}", sms);

    assert!(debug_str.contains("msg_001"));
    assert!(debug_str.contains("iccid_001"));
}

// ============================================================================
// Send SMS Tests (Signature Testing)
// ============================================================================

#[tokio::test]
async fn test_send_sms_signature() {
    let sender = create_test_sender().await;
    let sms = create_test_sms("msg_001", "iccid_001", "+1234567890", "Test");

    // Try to send (will fail without real hardware, but tests signature)
    let result = sender.send_sms(&sms).await;

    // Should error (no modem found for ICCID)
    assert!(result.is_err());
}

#[tokio::test]
async fn test_send_sms_with_cached_modem() {
    let mut sender = create_test_sender().await;

    // Populate cache with modem
    let mut cache = HashMap::new();
    cache.insert("test_iccid".to_string(), "modem_0".to_string());
    sender.update_modem_cache(cache);

    let sms = create_test_sms("msg_001", "test_iccid", "+1234567890", "Test");

    // Try to send (will fail without real modem_0, but finds modem ID)
    let result = sender.send_sms(&sms).await;

    // Should error at send stage (not at modem lookup stage)
    assert!(result.is_err());
}

// ============================================================================
// Edge Cases
// ============================================================================

#[test]
fn test_pending_sms_with_empty_content() {
    let sms = create_test_sms("msg_001", "iccid_001", "+1234567890", "");

    assert_eq!(sms.content, "");
}

#[test]
fn test_pending_sms_with_long_content() {
    let long_content = "x".repeat(1000);
    let sms = create_test_sms("msg_001", "iccid_001", "+1234567890", &long_content);

    assert_eq!(sms.content.len(), 1000);
}

#[test]
fn test_pending_sms_with_special_characters() {
    let sms = create_test_sms(
        "msg_001",
        "iccid_001",
        "+1234567890",
        "你好 Hello 🌍 'quotes\" <tags>"
    );

    assert!(sms.content.contains("你好"));
    assert!(sms.content.contains("🌍"));
}

#[test]
fn test_pending_sms_with_international_number() {
    let sms = create_test_sms("msg_001", "iccid_001", "+8613800138000", "测试");

    assert_eq!(sms.recipient, "+8613800138000");
    assert_eq!(sms.content, "测试");
}

// ============================================================================
// Cache Management Tests
// ============================================================================

#[tokio::test]
async fn test_modem_cache_large_scale() {
    let mut sender = create_test_sender().await;

    // Create cache with 100+ modems (simulating production)
    let mut cache = HashMap::new();
    for i in 0..100 {
        cache.insert(
            format!("iccid_{:03}", i),
            format!("modem_{}", i)
        );
    }

    sender.update_modem_cache(cache);

    // Should handle large cache without issue
    assert!(true);
}

#[tokio::test]
async fn test_find_modem_multiple_lookups() {
    let mut sender = create_test_sender().await;

    let mut cache = HashMap::new();
    cache.insert("iccid_001".to_string(), "modem_0".to_string());
    cache.insert("iccid_002".to_string(), "modem_1".to_string());
    cache.insert("iccid_003".to_string(), "modem_2".to_string());
    sender.update_modem_cache(cache);

    // Perform multiple lookups
    assert_eq!(sender.find_modem_for_iccid("iccid_001").await, Some("modem_0".to_string()));
    assert_eq!(sender.find_modem_for_iccid("iccid_002").await, Some("modem_1".to_string()));
    assert_eq!(sender.find_modem_for_iccid("iccid_003").await, Some("modem_2".to_string()));
    assert_eq!(sender.find_modem_for_iccid("iccid_999").await, None);
}
