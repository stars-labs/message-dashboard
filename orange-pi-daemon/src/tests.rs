use crate::identifiers::{Iccid, Imei, SimNumber, SmsAddress};
use crate::signal_cache::SignalCache;
use crate::sync_manager::SyncManager;
use crate::types::*;
use crate::wire::{Direction, ModemReport, ModemStatus, SyncMode};
use std::time::Duration;
use tokio::time::sleep;

#[tokio::test]
async fn test_signal_cache_basic() {
    let cache = SignalCache::new(2);

    assert!(cache.get("modem1").await.is_none());

    let signal = SignalData {
        percent: 75,
        rssi: -65,
    };
    cache.set("modem1".to_string(), signal.clone()).await;

    let cached = cache.get("modem1").await;
    assert!(cached.is_some());
    assert_eq!(cached.unwrap().percent, 75);
}

#[tokio::test]
async fn test_signal_cache_expiration() {
    let cache = SignalCache::new(1);

    let signal = SignalData {
        percent: 50,
        rssi: -85,
    };
    cache.set("modem1".to_string(), signal).await;

    assert!(cache.get("modem1").await.is_some());

    sleep(Duration::from_millis(1100)).await;

    assert!(cache.get("modem1").await.is_none());
}

#[test]
fn test_sync_manager_mode() {
    let sync_manager = SyncManager::new();

    assert!(sync_manager.needs_full_sync());
}

#[test]
fn test_message_structure() {
    let message = Message {
        phone_iccid: Iccid::try_from("89860121750097854321").unwrap(),
        phone_number: SmsAddress::from("+1234567890"),
        content: "Test message".to_string(),
        timestamp: chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
        direction: Direction::Received,
    };

    assert_eq!(message.phone_iccid.as_str().len(), 20);
    assert!(message.phone_number.as_str().starts_with('+'));
    assert!(!message.content.is_empty());
    assert!(message.timestamp.ends_with('Z'));
}

#[test]
fn test_modem_report_structure() {
    let report = ModemReport {
        equipment_id: Imei::try_from("123456789012345").unwrap(),
        manufacturer: Some("Quectel".to_string()),
        model: Some("EC20".to_string()),
        firmware_revision: Some("1.0.0".to_string()),
        hardware_revision: None,
        status: ModemStatus::Active,
        detected_iccid: Some(Iccid::try_from("89860121750097854321").unwrap()),
        detected_phone_number: Some(SimNumber::try_from("+1234567890").unwrap()),
        detected_operator: Some("Test Operator".to_string()),
        signal_percent: Some(75),
        rssi: Some(-65),
        modem_index: Some(14),
        usb_port: None,
        usb_path: Some("1-1.4.2.2.2".to_string()),
    };

    assert_eq!(report.equipment_id.as_str(), "123456789012345");
    assert_eq!(report.status, ModemStatus::Active);
    assert_eq!(report.signal_percent, Some(75));
    assert_eq!(
        report.detected_iccid,
        Some(Iccid::try_from("89860121750097854321").unwrap())
    );

    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["equipment_id"], "123456789012345");
    assert_eq!(json["detected_iccid"], "89860121750097854321");
    assert!(json.get("usb_port").is_none());
    assert_eq!(json["usb_path"], "1-1.4.2.2.2");

    let parsed: ModemReport = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.usb_path, Some("1-1.4.2.2.2".to_string()));

    let report_no_path = ModemReport {
        usb_path: None,
        ..report
    };
    let json_no_path = serde_json::to_value(&report_no_path).unwrap();
    assert!(json_no_path.get("usb_path").is_none());
}

#[test]
fn test_timestamp_formatting() {
    let now = chrono::Utc::now();
    let formatted = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    assert!(formatted.contains('T'));
    assert!(formatted.ends_with('Z'));
    assert_eq!(formatted.len(), 24);

    let message = Message {
        phone_iccid: Iccid::try_from("a1").unwrap(),
        phone_number: SmsAddress::from("test"),
        content: "test".to_string(),
        timestamp: formatted.clone(),
        direction: Direction::Unknown("test".to_string()),
    };

    assert_eq!(message.timestamp, formatted);
}

#[test]
fn test_sync_mode_string() {
    assert_eq!(SyncMode::Full.as_str(), "full");
    assert_eq!(SyncMode::Incremental.as_str(), "incremental");
}

#[test]
fn test_api_client_creation() {
    use crate::api_client::ApiClient;
    use crate::types::Config;

    let config = Config {
        api_url: "https://test.example.com".to_string(),
        api_key: "test_key".into(),
    };
    let _client = ApiClient::new(config).unwrap();
}

#[tokio::test]
async fn test_sms_sender_creation() {
    use crate::api_client::ApiClient;
    use crate::modem_manager::ModemManager;
    use crate::sms_sender::SmsSender;
    use crate::types::Config;
    use std::sync::Arc;

    let config = Config {
        api_url: "https://test.example.com".to_string(),
        api_key: "test_key".into(),
    };
    let api_client = ApiClient::new(config).unwrap();
    let modem_manager = Arc::new(ModemManager::new());
    let mut sender = SmsSender::new(api_client, modem_manager, "test-session".to_string());

    let mut cache = std::collections::HashMap::new();
    cache.insert(
        Iccid::try_from("89860000000000000001").unwrap(),
        "modem1".to_string(),
    );
    sender.update_modem_cache(cache);
}
