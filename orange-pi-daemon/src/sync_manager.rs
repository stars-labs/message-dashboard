use crate::types::ModemReport;
use std::collections::{HashMap, HashSet};
use tracing::{info, warn};

/// Sync mode for state reconciliation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// Full state sync - reconcile all devices with server
    Full,
    /// Incremental update - only send changed data
    Incremental,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DeviceDelta {
    pub reports: Vec<ModemReport>,
    pub removed_equipment_ids: Vec<String>,
}

/// Merge successful reads into the last known report snapshot while using USB
/// discovery, not AT-command success, as the authority for physical removal.
pub fn merge_device_reports<I>(
    previous: &HashMap<String, ModemReport>,
    discovered_modem_ids: &[String],
    successful_reports: I,
) -> HashMap<String, ModemReport>
where
    I: IntoIterator<Item = (String, ModemReport)>,
{
    let discovered: HashSet<&str> = discovered_modem_ids.iter().map(String::as_str).collect();
    let mut merged: HashMap<String, ModemReport> = previous
        .iter()
        .filter(|(modem_id, _)| discovered.contains(modem_id.as_str()))
        .map(|(modem_id, report)| (modem_id.clone(), report.clone()))
        .collect();
    merged.extend(successful_reports);
    merged
}

fn signal_band(signal_percent: Option<i32>) -> u8 {
    match signal_percent.unwrap_or(0) {
        75.. => 4,
        50..=74 => 3,
        25..=49 => 2,
        1..=24 => 1,
        _ => 0,
    }
}

fn device_state_changed(previous: &ModemReport, current: &ModemReport) -> bool {
    previous.manufacturer != current.manufacturer
        || previous.model != current.model
        || previous.firmware_revision != current.firmware_revision
        || previous.hardware_revision != current.hardware_revision
        || previous.status != current.status
        || previous.detected_iccid != current.detected_iccid
        || previous.detected_phone_number != current.detected_phone_number
        || previous.detected_operator != current.detected_operator
        || previous.modem_index != current.modem_index
        || previous.usb_port != current.usb_port
        || previous.usb_path != current.usb_path
        || signal_band(previous.signal_percent) != signal_band(current.signal_percent)
}

/// Return only reports whose durable dashboard state changed, plus explicit removals.
/// Raw signal and RSSI noise inside the same UI signal band is intentionally ignored.
pub fn device_delta(previous: &[ModemReport], current: &[ModemReport]) -> DeviceDelta {
    let previous_by_id: HashMap<&str, &ModemReport> = previous
        .iter()
        .map(|report| (report.equipment_id.as_str(), report))
        .collect();
    let current_ids: HashSet<&str> = current
        .iter()
        .map(|report| report.equipment_id.as_str())
        .collect();

    let reports = current
        .iter()
        .filter(|report| {
            previous_by_id
                .get(report.equipment_id.as_str())
                .is_none_or(|previous| device_state_changed(previous, report))
        })
        .cloned()
        .collect();

    let mut removed_equipment_ids: Vec<String> = previous
        .iter()
        .filter(|report| !current_ids.contains(report.equipment_id.as_str()))
        .map(|report| report.equipment_id.clone())
        .collect();
    removed_equipment_ids.sort();

    DeviceDelta {
        reports,
        removed_equipment_ids,
    }
}

impl SyncMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SyncMode::Full => "full",
            SyncMode::Incremental => "incremental",
        }
    }
}

/// Manages synchronization state between daemon and server
/// Implements full/incremental sync pattern for efficient updates
pub struct SyncManager {
    full_sync_completed: bool,
    consecutive_failures: u32,
}

impl SyncManager {
    pub fn new() -> Self {
        info!("🔄 Device sync manager initialized");

        Self {
            full_sync_completed: false,
            consecutive_failures: 0,
        }
    }

    /// Check if a full sync is needed
    ///
    /// Full sync is needed when:
    /// 1. Never done before
    /// 2. Multiple consecutive failures require reconciliation after recovery
    pub fn needs_full_sync(&self) -> bool {
        // Never synced before
        if !self.full_sync_completed {
            return true;
        }

        // Recovery mode after failures
        if self.consecutive_failures >= 3 {
            warn!(
                "⚠️  {} consecutive sync failures - forcing full sync for recovery",
                self.consecutive_failures
            );
            return true;
        }

        false
    }

    /// Get the appropriate sync mode
    pub fn get_sync_mode(&self) -> SyncMode {
        if self.needs_full_sync() {
            SyncMode::Full
        } else {
            SyncMode::Incremental
        }
    }

    /// Record a successful sync
    pub fn record_success(&mut self, sync_mode: SyncMode) {
        self.consecutive_failures = 0;

        if sync_mode == SyncMode::Full {
            self.full_sync_completed = true;
            info!("✅ Full sync completed successfully");
        } else {
            info!("✅ Incremental sync completed successfully");
        }
    }

    /// Record a failed sync attempt
    pub fn record_failure(&mut self, sync_mode: SyncMode, error: &dyn std::error::Error) {
        self.consecutive_failures += 1;

        warn!(
            "❌ {} sync failed (failure #{}):{}",
            sync_mode.as_str(),
            self.consecutive_failures,
            error
        );

        if self.consecutive_failures >= 5 {
            warn!(
                "🚨 {} consecutive sync failures - system may need attention",
                self.consecutive_failures
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn report(equipment_id: &str, signal_percent: i32) -> ModemReport {
        ModemReport {
            equipment_id: equipment_id.to_string(),
            manufacturer: Some("Quectel".to_string()),
            model: Some("EC20".to_string()),
            firmware_revision: Some("1".to_string()),
            hardware_revision: Some("1".to_string()),
            status: "active".to_string(),
            detected_iccid: Some(format!("iccid-{equipment_id}")),
            detected_phone_number: None,
            detected_operator: Some("carrier".to_string()),
            signal_percent: Some(signal_percent),
            rssi: Some(-70),
            modem_index: Some(1),
            usb_port: Some(1),
            usb_path: Some(format!("1-{equipment_id}")),
        }
    }

    #[test]
    fn test_initial_state_needs_full_sync() {
        let sm = SyncManager::new();
        assert!(sm.needs_full_sync());
        assert_eq!(sm.get_sync_mode(), SyncMode::Full);
    }

    #[test]
    fn test_incremental_after_success() {
        let mut sm = SyncManager::new();

        sm.record_success(SyncMode::Full);
        assert!(!sm.needs_full_sync());
        assert_eq!(sm.get_sync_mode(), SyncMode::Incremental);
    }

    #[test]
    fn test_failures_trigger_full_sync() {
        let mut sm = SyncManager::new();

        sm.record_success(SyncMode::Full);
        assert!(!sm.needs_full_sync());

        // Simulate failures
        for _ in 0..3 {
            sm.record_failure(
                SyncMode::Incremental,
                &std::io::Error::new(std::io::ErrorKind::Other, "test"),
            );
        }

        assert!(sm.needs_full_sync());
    }

    #[test]
    fn device_delta_ignores_signal_noise_within_the_same_display_band() {
        let previous = vec![report("a", 80)];
        let current = vec![report("a", 76)];

        assert_eq!(device_delta(&previous, &current), DeviceDelta::default());
    }

    #[test]
    fn device_delta_emits_signal_band_and_device_state_changes() {
        let previous = vec![report("a", 80), report("b", 60)];
        let mut signal_changed = report("a", 49);
        signal_changed.rssi = Some(-92);
        let mut state_changed = report("b", 60);
        state_changed.status = "error".to_string();

        let delta = device_delta(&previous, &[signal_changed.clone(), state_changed.clone()]);

        assert_eq!(delta.reports, vec![signal_changed, state_changed]);
        assert!(delta.removed_equipment_ids.is_empty());
    }

    #[test]
    fn device_delta_emits_explicit_removals() {
        let previous = vec![report("a", 80), report("b", 60)];

        let delta = device_delta(&previous, &[report("a", 80)]);

        assert!(delta.reports.is_empty());
        assert_eq!(delta.removed_equipment_ids, vec!["b"]);
    }

    #[test]
    fn report_snapshot_preserves_transient_read_failures() {
        let previous = HashMap::from([
            ("port-a".to_string(), report("a", 80)),
            ("port-b".to_string(), report("b", 60)),
        ]);
        let discovered = vec!["port-a".to_string(), "port-b".to_string()];

        let snapshot = merge_device_reports(
            &previous,
            &discovered,
            vec![("port-a".to_string(), report("a", 49))],
        );

        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot["port-a"].signal_percent, Some(49));
        assert_eq!(snapshot["port-b"].equipment_id, "b");
    }

    #[test]
    fn report_snapshot_removes_only_modems_absent_from_discovery() {
        let previous = HashMap::from([
            ("port-a".to_string(), report("a", 80)),
            ("port-b".to_string(), report("b", 60)),
        ]);

        let snapshot = merge_device_reports(
            &previous,
            &["port-a".to_string()],
            Vec::<(String, ModemReport)>::new(),
        );

        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot["port-a"].equipment_id, "a");
        assert!(!snapshot.contains_key("port-b"));
    }
}
