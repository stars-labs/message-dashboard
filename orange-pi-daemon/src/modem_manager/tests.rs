use super::discovery::retain_present_cached_modems;
use super::queries::signal_from_percent;
use super::{CachedPort, ModemManager};
use crate::types::SmsStorage;
use std::collections::{BTreeMap, HashMap};

#[test]
fn test_signal_from_percent_maps_the_range_ends_and_rejects_overflow() {
    let low = signal_from_percent(0).unwrap();
    assert_eq!((low.percent, low.rssi), (0, -110));
    let high = signal_from_percent(100).unwrap();
    assert_eq!((high.percent, high.rssi), (100, 10));
    assert!(signal_from_percent(u32::MAX).is_err());
}

#[test]
fn test_format_storage_aware_at_sms_path() {
    let path = ModemManager::format_at_sms_path(&[(SmsStorage::Me, 5), (SmsStorage::Sm, 7)]);
    assert_eq!(path, "at:ME:5,SM:7");
    assert_eq!(
        ModemManager::format_at_sms_path(&[(SmsStorage::Mt, 0)]),
        "at:MT:0"
    );
}

#[test]
fn test_parse_storage_aware_at_sms_path() {
    assert_eq!(
        ModemManager::parse_at_sms_path("at:ME:5,sm:7").unwrap(),
        vec![(Some(SmsStorage::Me), 5), (Some(SmsStorage::Sm), 7)]
    );
    assert_eq!(
        ModemManager::parse_at_sms_path("at:MT:1").unwrap(),
        vec![(Some(SmsStorage::Mt), 1)]
    );
}

#[test]
fn test_parse_mixed_storage_and_legacy_at_sms_path() {
    assert_eq!(
        ModemManager::parse_at_sms_path("at:ME:5,7").unwrap(),
        vec![(Some(SmsStorage::Me), 5), (None, 7)]
    );
}

#[test]
fn test_at_sms_path_round_trips() {
    let locations = [
        (SmsStorage::Me, 5),
        (SmsStorage::Sm, 7),
        (SmsStorage::Mt, 9),
    ];
    let parsed =
        ModemManager::parse_at_sms_path(&ModemManager::format_at_sms_path(&locations)).unwrap();
    assert_eq!(
        parsed,
        locations
            .iter()
            .map(|(storage, index)| (Some(*storage), *index))
            .collect::<Vec<_>>()
    );
}

#[test]
fn test_parse_legacy_at_sms_path() {
    assert_eq!(
        ModemManager::parse_at_sms_path("at:5,7").unwrap(),
        vec![(None, 5), (None, 7)]
    );
}

#[test]
fn test_parse_at_sms_path_rejects_status_report_storage() {
    assert!(ModemManager::parse_at_sms_path("at:SR:5").is_err());
    assert!(ModemManager::parse_at_sms_path("at:ME:not-a-number").is_err());
    assert!(ModemManager::parse_at_sms_path("at:").is_err());
}

#[test]
fn test_parse_at_sms_path_rejects_malformed_paths_with_the_same_errors() {
    let message = |path: &str| {
        ModemManager::parse_at_sms_path(path)
            .unwrap_err()
            .to_string()
    };
    assert_eq!(message("at:sr:5"), "Invalid SMS storage in path: SR");
    assert_eq!(message("at::5"), "Invalid SMS storage in path: ");
    assert_eq!(message("at:ME:5,XX:7"), "Invalid SMS storage in path: XX");
    assert_eq!(message("at:ME:x"), "Invalid SMS index: x");
    assert_eq!(message("at:5,y"), "Invalid SMS index: y");
    assert_eq!(message("sms:ME:5"), "Invalid AT SMS path: sms:ME:5");
    assert!(ModemManager::parse_at_sms_path("at:ME:5,").is_err());
    assert!(ModemManager::parse_at_sms_path("at:ME:5:6").is_err());
}

fn cached(port: &str, device: &str) -> CachedPort {
    CachedPort {
        port: port.to_string(),
        usb_device: device.to_string(),
    }
}

#[test]
fn cached_modems_are_retained_only_while_their_usb_port_is_present() {
    let mut cache = HashMap::from([
        ("2".to_string(), cached("/dev/ttyUSB2", "1-1.1")),
        ("6".to_string(), cached("/dev/ttyUSB6", "1-1.2")),
    ]);
    let groups = BTreeMap::from([(
        "1-1.1".to_string(),
        (0..4).map(|n| format!("/dev/ttyUSB{n}")).collect(),
    )]);

    retain_present_cached_modems(&mut cache, &groups);

    assert_eq!(cache.keys().collect::<Vec<_>>(), vec!["2"]);
}

#[test]
fn a_cached_port_that_moved_to_another_device_is_dropped() {
    let mut cache = HashMap::from([("41".to_string(), cached("/dev/ttyUSB41", "1-1.3.2.1"))]);
    let groups = BTreeMap::from([(
        "1-1.3.3.2".to_string(),
        (40..44).map(|n| format!("/dev/ttyUSB{n}")).collect(),
    )]);

    retain_present_cached_modems(&mut cache, &groups);

    assert!(cache.is_empty());
}
