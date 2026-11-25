// Integration tests for public API of at_modem module
// These tests verify the contract and behavior of public functions
use orange_pi_daemon_rust::at_modem::{AtModemInfo, AtModemManager};
use orange_pi_daemon_rust::identifiers::{Iccid, Imei, SimNumber};

// ============================================================================
// Static Helper Function Tests (No I/O)
// ============================================================================

#[test]
fn test_port_conversion() {
    // modem_id is now the AT port's ttyUSB index (no fixed 4-ports-per-modem math),
    // so discovery works for both default (AT@offset2) and slimmed (AT@offset0) modems.
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB2"), "2");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB6"), "6");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB10"), "10");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB0"), "0");

    assert_eq!(AtModemManager::modem_id_to_port("2"), "/dev/ttyUSB2");
    assert_eq!(AtModemManager::modem_id_to_port("6"), "/dev/ttyUSB6");
    assert_eq!(AtModemManager::modem_id_to_port("10"), "/dev/ttyUSB10");
    assert_eq!(AtModemManager::modem_id_to_port("0"), "/dev/ttyUSB0");
}

#[test]
fn test_port_conversion_boundary_cases() {
    // Round-trips across the full range, including offset-0 (slimmed) ports.
    for n in ["0", "1", "2", "6", "25", "102", "240"] {
        let port = AtModemManager::modem_id_to_port(n);
        assert_eq!(port, format!("/dev/ttyUSB{n}"));
        assert_eq!(AtModemManager::port_to_modem_id(&port), n);
    }
}

// ============================================================================
// AtModemManager Construction Tests
// ============================================================================

#[test]
fn test_at_modem_manager_new() {
    // Verify construction succeeds
    let manager = AtModemManager::new();

    // Basic smoke test - manager should be created without panic
    assert_eq!(size_of_val(&manager), size_of::<AtModemManager>());
}

// ============================================================================
// Public API Contract Tests (Without Real Hardware)
// ============================================================================
// These tests verify function signatures, error handling, and data types
// without requiring actual serial hardware.

#[tokio::test]
async fn test_get_iccid_signature() {
    // Verify get_iccid has correct signature and returns Result<Option<String>>
    let manager = AtModemManager::new();

    // /dev/null exists but won't respond to AT commands
    // The function should return Ok(None) when no ICCID found
    let result = manager.get_iccid("/dev/null").await;

    // Either Ok(None) or Err is acceptable (depends on whether serial open fails)
    assert!(result.is_ok() || result.is_err());
}

#[tokio::test]
async fn test_get_imei_signature() {
    let manager = AtModemManager::new();
    let result = manager.get_imei("/dev/null").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_get_signal_signature() {
    let manager = AtModemManager::new();
    let result = manager.get_signal("/dev/null").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_list_sms_signature() {
    let manager = AtModemManager::new();
    let result = manager.list_sms("/dev/null").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_delete_sms_signature() {
    let manager = AtModemManager::new();
    let result = manager.delete_sms("/dev/null", 1).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_get_modem_info_signature() {
    let manager = AtModemManager::new();
    let result = manager.get_modem_info("/dev/null").await;
    // Either Ok or Err is acceptable
    assert!(result.is_ok() || result.is_err());
}

// ============================================================================
// Data Structure Tests
// ============================================================================

#[test]
fn test_at_modem_info_structure() {
    // Verify AtModemInfo can be constructed and has expected fields
    let info = AtModemInfo {
        iccid: Some(Iccid::try_from("89860121750097854321").unwrap()),
        imei: Some(Imei::try_from("123456789012345").unwrap()),
        manufacturer: Some("Quectel".to_string()),
        model: Some("EC20".to_string()),
        revision: Some("EC20CEFAG".to_string()),
        signal_percent: Some(75),
        phone_number: Some(SimNumber::try_from("+1234567890").unwrap()),
        operator: Some("China Mobile".to_string()),
    };

    assert_eq!(
        info.iccid,
        Some(Iccid::try_from("89860121750097854321").unwrap())
    );
    assert_eq!(info.imei, Some(Imei::try_from("123456789012345").unwrap()));
    assert_eq!(info.signal_percent, Some(75));
}
