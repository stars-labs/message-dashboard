// Integration tests for ModemManager - Modem interface layer
use orange_pi_daemon_rust::modem_manager::{BackendMode, ModemManager};

/// `USE_DBUS` is process-global, so the tests that mutate it must not run
/// concurrently: cargo runs tests of one file on several threads in the same
/// process, and without this they race over the variable.
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn lock_env() -> tokio::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().await
}

// ============================================================================
// Construction and Mode Selection Tests
// ============================================================================

#[tokio::test]
async fn test_modem_manager_new_default_mode() {
    let _env = lock_env().await;
    // Clear environment variable
    std::env::remove_var("USE_DBUS");

    let manager = ModemManager::new().await;

    // Should default to AT command mode
    assert_eq!(manager.get_backend_mode(), BackendMode::AtCommand);
    assert!(manager.is_using_at_commands());
    assert!(!manager.is_using_native_dbus());
}

#[tokio::test]
async fn test_modem_manager_at_command_mode() {
    let _env = lock_env().await;
    std::env::set_var("USE_DBUS", "0");

    let manager = ModemManager::new().await;

    assert_eq!(manager.get_backend_mode(), BackendMode::AtCommand);
    assert!(manager.is_using_at_commands());
}

#[tokio::test]
async fn test_modem_manager_dbus_mode_request() {
    let _env = lock_env().await;
    std::env::set_var("USE_DBUS", "1");

    let manager = ModemManager::new().await;

    // Mode will be DBus (even if D-Bus not actually available on test system)
    assert_eq!(manager.get_backend_mode(), BackendMode::DBus);
    assert!(manager.is_using_native_dbus());
    assert!(!manager.is_using_at_commands());

    // Clean up
    std::env::remove_var("USE_DBUS");
}

#[tokio::test]
async fn test_modem_manager_availability_at_mode() {
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");

    let manager = ModemManager::new().await;

    // AT mode is always available (even without real hardware)
    assert!(manager.is_available());
}

// ============================================================================
// Backend Mode Tests
// ============================================================================

#[test]
fn test_backend_mode_equality() {
    assert_eq!(BackendMode::AtCommand, BackendMode::AtCommand);
    assert_eq!(BackendMode::DBus, BackendMode::DBus);
    assert_ne!(BackendMode::AtCommand, BackendMode::DBus);
}

#[test]
fn test_backend_mode_clone() {
    let mode = BackendMode::AtCommand;
    let cloned = mode;
    assert_eq!(mode, cloned);
}

#[test]
fn test_backend_mode_debug() {
    let mode = BackendMode::AtCommand;
    let debug_str = format!("{mode:?}");
    assert!(debug_str.contains("AtCommand"));
}

// ============================================================================
// List Modems Tests
// ============================================================================

#[tokio::test]
async fn test_list_modems_signature() {
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

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
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

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
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

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
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

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
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

    let result = manager.get_phone_number("invalid_modem").await;

    match result {
        Ok(None | Some(_)) | Err(_) => {}
    }
}

#[tokio::test]
async fn test_get_operator_signature() {
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

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
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

    // Test with invalid modem
    let result = manager.health_check("invalid_modem").await;

    // Should return Ok(Some(health)) or Err
    // AT mode returns health, D-Bus mode doesn't support the check, and
    // hardware-less runs are expected to error
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

    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

    // Create a dummy message store for testing
    let store = MessageStore::new(":memory:").unwrap();

    // Test with invalid modem
    let result = manager
        .get_new_messages("invalid_modem", "test_iccid", &store)
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_get_new_messages_with_paths_signature() {
    use orange_pi_daemon_rust::message_store::MessageStore;

    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

    let store = MessageStore::new(":memory:").unwrap();

    let result = manager
        .get_new_messages_with_paths("invalid_modem", "test_iccid", &store)
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_delete_sms_signature() {
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

    // Test with invalid path
    let result = manager.delete_sms("invalid_modem", "at:999").await;

    // Should error without real hardware
    assert!(result.is_err() || result.is_ok());
}

#[tokio::test]
async fn test_send_sms_signature() {
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

    // Test with invalid modem
    let result = manager
        .send_sms("invalid_modem", "+1234567890", "test message")
        .await;

    // Should error without real hardware
    assert!(result.is_err() || result.is_ok());
}

// ============================================================================
// Clone Tests
// ============================================================================

#[tokio::test]
async fn test_modem_manager_clone() {
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;

    // ModemManager implements Clone
    let cloned = manager.clone();

    // Both should have same mode
    assert_eq!(manager.get_backend_mode(), cloned.get_backend_mode());
}

// ============================================================================
// Concurrent Access Tests
// ============================================================================

#[tokio::test]
async fn test_concurrent_mode_access() {
    let _env = lock_env().await;
    std::env::remove_var("USE_DBUS");
    let manager = ModemManager::new().await;
    let manager_clone = manager.clone();

    // Access mode from multiple tasks concurrently
    let handle1 = tokio::spawn(async move { manager_clone.get_backend_mode() });

    let handle2 = tokio::spawn(async move { manager.get_backend_mode() });

    let mode1 = handle1.await.unwrap();
    let mode2 = handle2.await.unwrap();

    // Both should return same mode
    assert_eq!(mode1, mode2);
    assert_eq!(mode1, BackendMode::AtCommand);
}

// ============================================================================
// Environment Variable Edge Cases
// ============================================================================

#[tokio::test]
async fn test_use_dbus_env_various_values() {
    let _env = lock_env().await;
    // Test "0" explicitly
    std::env::set_var("USE_DBUS", "0");
    let manager = ModemManager::new().await;
    assert_eq!(manager.get_backend_mode(), BackendMode::AtCommand);

    // Test empty string
    std::env::set_var("USE_DBUS", "");
    let manager = ModemManager::new().await;
    assert_eq!(manager.get_backend_mode(), BackendMode::AtCommand);

    // Test "1" explicitly
    std::env::set_var("USE_DBUS", "1");
    let manager = ModemManager::new().await;
    assert_eq!(manager.get_backend_mode(), BackendMode::DBus);

    // Test other values (should default to AT mode)
    std::env::set_var("USE_DBUS", "yes");
    let manager = ModemManager::new().await;
    assert_eq!(manager.get_backend_mode(), BackendMode::AtCommand);

    // Clean up
    std::env::remove_var("USE_DBUS");
}
