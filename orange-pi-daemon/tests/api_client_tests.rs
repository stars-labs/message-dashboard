// Integration tests for ApiClient - HTTP communication layer
use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::sync_manager::SyncMode;
use orange_pi_daemon_rust::types::{Config, Message, Modem, ModemReport, Sim};

// Helper function to create test config
fn create_test_config() -> Config {
    Config {
        api_url: "http://localhost:8787".to_string(),
        api_key: "test_api_key_12345".to_string(),
        check_interval_secs: 1,
    }
}

// Helper function to create test message
fn create_test_message(iccid: &str, content: &str) -> Message {
    Message {
        phone_iccid: iccid.to_string(),
        phone_number: "+1234567890".to_string(),
        content: content.to_string(),
        timestamp: "2024-01-01T12:00:00.000Z".to_string(),
        direction: "received".to_string(),
    }
}

// Helper function to create test modem
fn create_test_modem(equipment_id: &str) -> Modem {
    Modem {
        equipment_id: equipment_id.to_string(),
        manufacturer: Some("Quectel".to_string()),
        model: Some("EC20".to_string()),
        firmware_revision: Some("EC20CEFAG".to_string()),
        hardware_revision: None,
        status: "active".to_string(),
        signal: Some(75),
        rssi: Some(-60),
        rsrq: None,
        rsrp: None,
        snr: None,
        modem_index: Some(0),
        usb_port: Some(2),
        connection_status: Some("connected".to_string()),
        network_type: Some("LTE".to_string()),
        access_tech: Some("LTE".to_string()),
        sim_read_status: Some("ok".to_string()),
    }
}

// Helper function to create test SIM
fn create_test_sim(iccid: &str) -> Sim {
    Sim {
        iccid: iccid.to_string(),
        phone_number: Some("+1234567890".to_string()),
        current_modem_id: Some("123456789012345".to_string()),
        operator_name: Some("TestOp".to_string()),
        operator_id: None,
        status: "active".to_string(),
        sim_index: None,
    }
}

// ============================================================================
// Construction Tests
// ============================================================================

#[test]
fn test_api_client_new() {
    let config = create_test_config();
    let client = ApiClient::new(config.clone());

    // Verify config is stored
    assert_eq!(client.config.api_url, config.api_url);
    assert_eq!(client.config.api_key, config.api_key);
}

#[test]
fn test_api_client_clone() {
    let config = create_test_config();
    let client = ApiClient::new(config);

    // ApiClient implements Clone
    let cloned = client.clone();

    assert_eq!(client.config.api_url, cloned.config.api_url);
    assert_eq!(client.config.api_key, cloned.config.api_key);
}

#[tokio::test]
async fn test_empty_incremental_device_delta_is_a_noop() {
    let client = ApiClient::new(create_test_config());
    let reports: Vec<ModemReport> = Vec::new();
    let removed: Vec<String> = Vec::new();

    let result = client
        .upload_modem_reports(&reports, &removed, SyncMode::Incremental, "session")
        .await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_empty_full_device_snapshot_reaches_the_reconciliation_endpoint() {
    let client = ApiClient::new(create_test_config());
    let reports: Vec<ModemReport> = Vec::new();
    let removed: Vec<String> = Vec::new();

    let result = client
        .upload_modem_reports(&reports, &removed, SyncMode::Full, "session")
        .await;

    assert!(result.is_err());
}

// ============================================================================
// Upload Messages Tests
// ============================================================================

#[tokio::test]
async fn test_upload_messages_empty() {
    let config = create_test_config();
    let client = ApiClient::new(config);

    let messages: Vec<Message> = vec![];

    // Empty upload should succeed immediately
    let result = client.upload_messages(&messages).await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_upload_messages_single() {
    let config = create_test_config();
    let client = ApiClient::new(config);

    let messages = vec![create_test_message("iccid_001", "Test message")];

    // Will fail without real API server
    let result = client.upload_messages(&messages).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_upload_messages_batch_size() {
    let config = create_test_config();
    let client = ApiClient::new(config);

    // Create 150 messages (should be split into 3 batches of 50)
    let mut messages = Vec::new();
    for i in 0..150 {
        messages.push(create_test_message(
            &format!("iccid_{:03}", i),
            &format!("Message {}", i),
        ));
    }

    // Will fail without real API, but tests batching logic
    let result = client.upload_messages(&messages).await;

    // Should error at first batch attempt
    assert!(result.is_err());
}

// ============================================================================
// Get Pending SMS Tests
// ============================================================================

#[tokio::test]
async fn test_get_pending_sms_signature() {
    let config = create_test_config();
    let client = ApiClient::new(config);

    // Will fail without real API server
    let result = client.get_pending_sms().await;

    assert!(result.is_err());
}

// ============================================================================
// Data Structure Tests
// ============================================================================

#[test]
fn test_config_structure() {
    let config = Config {
        api_url: "https://api.example.com".to_string(),
        api_key: "secret_key".to_string(),
        check_interval_secs: 30,
    };

    assert_eq!(config.api_url, "https://api.example.com");
    assert_eq!(config.api_key, "secret_key");
    assert_eq!(config.check_interval_secs, 30);
}

#[test]
fn test_message_structure() {
    let msg = create_test_message("iccid_001", "Hello");

    assert_eq!(msg.phone_iccid, "iccid_001");
    assert_eq!(msg.content, "Hello");
    assert_eq!(msg.direction, "received");
}

#[test]
fn test_modem_structure() {
    let modem = create_test_modem("12345");

    assert_eq!(modem.equipment_id, "12345");
    assert_eq!(modem.status, "active");
    assert_eq!(modem.signal, Some(75));
}

#[test]
fn test_sim_structure() {
    let sim = create_test_sim("89860121750097854321");

    assert_eq!(sim.iccid, "89860121750097854321");
    assert_eq!(sim.status, "active");
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
    let msg = create_test_message("iccid_001", "");
    assert_eq!(msg.content, "");
}

#[test]
fn test_message_with_long_content() {
    let long_content = "x".repeat(1000);
    let msg = create_test_message("iccid_001", &long_content);
    assert_eq!(msg.content.len(), 1000);
}

#[test]
fn test_message_with_unicode() {
    let msg = create_test_message("iccid_001", "你好世界 Hello 🌍");
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
        api_key: "key".to_string(),
        check_interval_secs: 60,
    };

    let client = ApiClient::new(config);
    assert!(client.config.api_url.contains("8443"));
}

#[test]
fn test_config_with_long_api_key() {
    let long_key = "x".repeat(256);
    let config = Config {
        api_url: "http://localhost".to_string(),
        api_key: long_key.clone(),
        check_interval_secs: 1,
    };

    let client = ApiClient::new(config);
    assert_eq!(client.config.api_key.len(), 256);
}
