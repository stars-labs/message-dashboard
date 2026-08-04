pub mod api_client;
pub mod at_modem;
pub mod benchmark;
pub mod dbus_client;
pub mod message_store;
pub mod modem_manager;
pub mod native_dbus;
pub mod retry_manager;
pub mod signal_cache;
pub mod sms_assembler;
pub mod sms_sender;
pub mod sync_manager;
pub mod types;
pub mod worker_pool;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retry_manager::RetryManager;
    use crate::signal_cache::SignalCache;
    use crate::sync_manager::{SyncManager, SyncMode};
    use crate::types::*;
    use std::time::Duration;
    use tokio::time::sleep;

    #[tokio::test]
    async fn test_signal_cache_basic() {
        let cache = SignalCache::new(2); // 2 second TTL

        // First access should miss
        assert!(cache.get("modem1").await.is_none());

        // Store signal data
        let signal = SignalData {
            percent: 75,
            rssi: -65,
        };
        cache.set("modem1".to_string(), signal.clone()).await;

        // Second access should hit
        let cached = cache.get("modem1").await;
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().percent, 75);
    }

    #[tokio::test]
    async fn test_signal_cache_expiration() {
        let cache = SignalCache::new(1); // 1 second TTL

        let signal = SignalData {
            percent: 50,
            rssi: -85,
        };
        cache.set("modem1".to_string(), signal).await;

        // Should hit immediately
        assert!(cache.get("modem1").await.is_some());

        // Wait for expiration
        sleep(Duration::from_millis(1100)).await;

        // Should miss after expiration
        assert!(cache.get("modem1").await.is_none());
    }

    #[test]
    fn test_sync_manager_initialization() {
        let sync_manager = SyncManager::new("test-session".to_string(), 300);
        assert_eq!(sync_manager.session_id(), "test-session");
    }

    #[test]
    fn test_sync_manager_mode() {
        let sync_manager = SyncManager::new("test".to_string(), 300);

        // First sync should always be full
        assert!(sync_manager.needs_full_sync());
        assert_eq!(sync_manager.get_sync_mode(), SyncMode::Full);
    }

    #[test]
    fn test_retry_manager_basic() {
        let retry_manager = RetryManager::new(3, 1000);

        // Should allow first few retries
        assert!(retry_manager.should_retry());
    }

    #[test]
    fn test_retry_manager_delays() {
        let mut retry_manager = RetryManager::new(3, 1000);

        // Get delays for attempts
        let delay1 = retry_manager.next_delay();
        assert_eq!(delay1, 1000); // Base delay

        let delay2 = retry_manager.next_delay();
        assert_eq!(delay2, 2000); // Exponential backoff

        let delay3 = retry_manager.next_delay();
        assert_eq!(delay3, 4000); // Further backoff
    }

    #[test]
    fn test_message_structure() {
        let message = Message {
            phone_iccid: "89860121750097854321".to_string(),
            phone_number: "+1234567890".to_string(),
            content: "Test message".to_string(),
            timestamp: chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
            direction: "received".to_string(),
        };

        assert_eq!(message.phone_iccid.len(), 20);
        assert!(message.phone_number.starts_with('+'));
        assert!(!message.content.is_empty());
        assert!(message.timestamp.ends_with('Z'));
    }

    #[test]
    fn test_modem_structure() {
        let modem = Modem {
            equipment_id: "IMEI123456789".to_string(),
            manufacturer: Some("Quectel".to_string()),
            model: Some("EC20".to_string()),
            firmware_revision: Some("1.0.0".to_string()),
            hardware_revision: None,
            status: "connected".to_string(),
            signal: Some(75),
            rssi: Some(-65),
            rsrq: None,
            rsrp: None,
            snr: None,
            modem_index: None,
            usb_port: None,
            connection_status: Some("active".to_string()),
            network_type: Some("LTE".to_string()),
            access_tech: Some("4G".to_string()),
            sim_read_status: Some("ok".to_string()),
        };

        assert_eq!(modem.status, "connected");
        assert_eq!(modem.signal, Some(75));
        assert_eq!(modem.manufacturer, Some("Quectel".to_string()));
    }

    #[test]
    fn test_modem_report_structure() {
        let report = ModemReport {
            equipment_id: "IMEI123456789".to_string(),
            manufacturer: Some("Quectel".to_string()),
            model: Some("EC20".to_string()),
            firmware_revision: Some("1.0.0".to_string()),
            hardware_revision: None,
            status: "active".to_string(),
            detected_iccid: Some("89860121750097854321".to_string()),
            detected_phone_number: Some("+1234567890".to_string()),
            detected_operator: Some("Test Operator".to_string()),
            signal_percent: Some(75),
            rssi: Some(-65),
            modem_index: Some(14),
            usb_port: None,
            usb_path: Some("1-1.4.2.2.2".to_string()),
        };

        assert_eq!(report.equipment_id, "IMEI123456789");
        assert_eq!(report.status, "active");
        assert_eq!(report.signal_percent, Some(75));
        assert_eq!(report.detected_iccid, Some("89860121750097854321".to_string()));

        // Test serialization — modem_reports format
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["equipment_id"], "IMEI123456789");
        assert_eq!(json["detected_iccid"], "89860121750097854321");
        assert!(json.get("usb_port").is_none()); // skip_serializing_if = None
        assert_eq!(json["usb_path"], "1-1.4.2.2.2");

        // Round-trip back into the struct
        let parsed: ModemReport = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.usb_path, Some("1-1.4.2.2.2".to_string()));

        // usb_path = None must be omitted from the wire format
        let report_no_path = ModemReport { usb_path: None, ..report };
        let json_no_path = serde_json::to_value(&report_no_path).unwrap();
        assert!(json_no_path.get("usb_path").is_none());
    }

    #[test]
    fn test_sim_structure() {
        let sim = Sim {
            iccid: "89860121750097854321".to_string(),
            phone_number: Some("+1234567890".to_string()),
            current_modem_id: Some("IMEI123".to_string()),
            operator_name: Some("Test Operator".to_string()),
            operator_id: Some("12345".to_string()),
            status: "active".to_string(),
            sim_index: Some(0),
        };

        assert_eq!(sim.iccid.len(), 20);
        assert_eq!(sim.status, "active");
        assert_eq!(sim.operator_name, Some("Test Operator".to_string()));
    }

    #[test]
    fn test_sim_phone_association() {
        let sim = Sim {
            iccid: "89860121750097854321".to_string(),
            phone_number: Some("+1234567890".to_string()),
            current_modem_id: Some("IMEI456".to_string()),
            operator_name: Some("Carrier".to_string()),
            operator_id: None,
            status: "active".to_string(),
            sim_index: Some(1),
        };

        // Verify SIM is associated with a modem
        assert!(sim.current_modem_id.is_some());
        assert_eq!(sim.current_modem_id, Some("IMEI456".to_string()));

        // Verify phone number is present
        assert!(sim.phone_number.is_some());
        assert!(sim.phone_number.unwrap().starts_with('+'));
    }

    #[test]
    fn test_timestamp_formatting() {
        let now = chrono::Utc::now();
        let formatted = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

        // Verify format: YYYY-MM-DDTHH:MM:SS.sssZ
        assert!(formatted.contains('T'));
        assert!(formatted.ends_with('Z'));
        assert_eq!(formatted.len(), 24);

        // Ensure consistent format across all timestamp fields
        let message = Message {
            phone_iccid: "test".to_string(),
            phone_number: "test".to_string(),
            content: "test".to_string(),
            timestamp: formatted.clone(),
            direction: "test".to_string(),
        };

        assert_eq!(message.timestamp, formatted);
    }

    #[test]
    fn test_sync_mode_string() {
        assert_eq!(SyncMode::Full.as_str(), "full");
        assert_eq!(SyncMode::Incremental.as_str(), "incremental");
    }

    #[tokio::test]
    async fn test_dbus_client_creation() {
        use crate::dbus_client::DBusClient;
        let _client = DBusClient::new().await;
        // Should create without panicking
    }

    #[tokio::test]
    async fn test_modem_manager_creation() {
        use crate::modem_manager::ModemManager;
        let _manager = ModemManager::new().await;
        // Should create with D-Bus client and signal cache
    }

    #[test]
    fn test_api_client_creation() {
        use crate::api_client::ApiClient;
        use crate::types::Config;

        let config = Config {
            api_url: "https://test.example.com".to_string(),
            api_key: "test_key".to_string(),
            check_interval_secs: 30,
        };
        let _client = ApiClient::new(config);
        // Should create without panicking
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
            api_key: "test_key".to_string(),
            check_interval_secs: 30,
        };
        let api_client = ApiClient::new(config);
        let modem_manager = Arc::new(ModemManager::new().await);
        let mut sender = SmsSender::new(api_client, modem_manager);

        // Test cache update
        let mut cache = std::collections::HashMap::new();
        cache.insert("iccid1".to_string(), "modem1".to_string());
        sender.update_modem_cache(cache);
    }
}
