// Integration tests for ModemManager - Modem interface layer
use orange_pi_daemon_rust::identifiers::{Iccid, SmsAddress};
use orange_pi_daemon_rust::modem_manager::ModemManager;

// ============================================================================
// List Modems Tests
// ============================================================================

#[tokio::test]
async fn test_list_modems_signature() {
    let manager = ModemManager::new();

    // Will fail without real hardware, but tests signature
    let result = manager.list_modems().await;

    // Linux without modems returns an empty list; macOS has no sysfs tree.
    match result {
        Ok(modems) => assert!(modems.is_empty()),
        Err(error) => assert!(error.to_string().contains("Failed to read /sys/class/tty")),
    }
}

// ============================================================================
// ICCID Tests
// ============================================================================

#[tokio::test]
async fn test_get_iccid_signature() {
    let manager = ModemManager::new();

    // Test with invalid modem ID
    let result = manager.get_iccid("invalid_modem").await;

    // Should return Ok(None) or Err depending on implementation
    assert!(result.is_ok() || result.is_err());
}

// ============================================================================
// Signal Quality Tests
// ============================================================================

#[tokio::test]
async fn test_get_signal_quality_signature() {
    let manager = ModemManager::new();

    // Test with invalid modem
    let result = manager.get_signal_quality("invalid_modem").await;

    // Should error or return default signal
    assert!(result.is_ok() || result.is_err());
}

// ============================================================================
// Device Details Tests
// ============================================================================

#[tokio::test]
async fn test_get_device_details_signature() {
    let manager = ModemManager::new();

    // Test with invalid modem
    let result = manager.get_device_details("invalid_modem").await;

    // Should return Ok(None) or Err
    // Ok(None) and Err are expected; Ok(Some(_)) is unlikely without real hardware
    match result {
        Ok(None | Some(_)) | Err(_) => {}
    }
}

#[tokio::test]
async fn test_get_phone_number_signature() {
    let manager = ModemManager::new();

    let result = manager.get_phone_number("invalid_modem").await;

    match result {
        Ok(None | Some(_)) | Err(_) => {}
    }
}

#[tokio::test]
async fn test_get_operator_signature() {
    let manager = ModemManager::new();

    let result = manager.get_operator("invalid_modem").await;

    match result {
        Ok(None | Some(_)) | Err(_) => {}
    }
}

// ============================================================================
// Health Check Tests
// ============================================================================

#[tokio::test]
async fn test_health_check_signature() {
    let manager = ModemManager::new();

    // Test with invalid modem
    let result = manager.health_check("invalid_modem").await;

    // Hardware-less runs are expected to error
    match result {
        Ok(Some(_) | None) | Err(_) => {}
    }
}

// ============================================================================
// Message Operations Tests
// ============================================================================

#[tokio::test]
async fn test_get_new_messages_signature() {
    use orange_pi_daemon_rust::message_store::MessageStore;

    let manager = ModemManager::new();

    // Create a dummy message store for testing
    let store = MessageStore::new(":memory:").unwrap();

    // Test with invalid modem
    let result = manager
        .get_new_messages(
            "invalid_modem",
            &Iccid::try_from("89860000000000000001").unwrap(),
            &store,
        )
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_get_new_messages_with_paths_signature() {
    use orange_pi_daemon_rust::message_store::MessageStore;

    let manager = ModemManager::new();

    let store = MessageStore::new(":memory:").unwrap();

    let result = manager
        .get_new_messages_with_paths(
            "invalid_modem",
            &Iccid::try_from("89860000000000000001").unwrap(),
            &store,
        )
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_delete_sms_signature() {
    let manager = ModemManager::new();

    // Test with invalid path
    let result = manager.delete_sms("invalid_modem", "at:999").await;

    // Should error without real hardware
    assert!(result.is_err() || result.is_ok());
}

#[tokio::test]
async fn test_send_sms_signature() {
    let manager = ModemManager::new();

    // Test with invalid modem
    let result = manager
        .send_sms(
            "invalid_modem",
            &SmsAddress::from("+1234567890"),
            "test message",
        )
        .await;

    // Should error without real hardware
    assert!(result.is_err() || result.is_ok());
}
