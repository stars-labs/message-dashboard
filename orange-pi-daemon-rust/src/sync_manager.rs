use std::time::{Duration, Instant};
use tracing::{info, warn};
use crate::types::{Modem, Sim};

/// Sync mode for state reconciliation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// Full state sync - reconcile all devices with server
    Full,
    /// Incremental update - only send changed data
    Incremental,
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
/// Implements full/incremental sync pattern from Zig daemon
pub struct SyncManager {
    session_id: String,
    last_full_sync: Option<Instant>,
    last_sync: Option<Instant>,
    consecutive_failures: u32,
    full_sync_interval: Duration,
    min_sync_interval: Duration,
}

impl SyncManager {
    /// Create a new sync manager with a unique session ID
    ///
    /// # Arguments
    /// * `session_id` - Unique session ID for this daemon instance
    /// * `full_sync_interval_secs` - How often to do full syncs (default: 300s = 5 minutes)
    pub fn new(session_id: String, full_sync_interval_secs: u64) -> Self {
        info!("🔑 Sync manager initialized with session ID: {}", session_id);

        Self {
            session_id,
            last_full_sync: None,
            last_sync: None,
            consecutive_failures: 0,
            full_sync_interval: Duration::from_secs(full_sync_interval_secs),
            min_sync_interval: Duration::from_secs(10), // Minimum 10s between syncs
        }
    }

    /// Get the session ID for this daemon instance
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Check if a full sync is needed
    ///
    /// Full sync is needed when:
    /// 1. Never done before
    /// 2. Interval since last full sync exceeded
    /// 3. Multiple consecutive failures (recovery)
    pub fn needs_full_sync(&self) -> bool {
        // Never synced before
        if self.last_full_sync.is_none() {
            return true;
        }

        // Check interval
        if let Some(last) = self.last_full_sync {
            if last.elapsed() >= self.full_sync_interval {
                return true;
            }
        }

        // Recovery mode after failures
        if self.consecutive_failures >= 3 {
            warn!("⚠️  {} consecutive sync failures - forcing full sync for recovery", self.consecutive_failures);
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

    /// Check if enough time has passed since last sync
    pub fn can_sync_now(&self) -> bool {
        match self.last_sync {
            None => true,
            Some(last) => last.elapsed() >= self.min_sync_interval,
        }
    }

    /// Record a successful sync
    pub fn record_success(&mut self, sync_mode: SyncMode) {
        self.last_sync = Some(Instant::now());
        self.consecutive_failures = 0;

        if sync_mode == SyncMode::Full {
            self.last_full_sync = Some(Instant::now());
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
            warn!("🚨 {} consecutive sync failures - system may need attention", self.consecutive_failures);
        }
    }

    /// Validate sync data before sending
    ///
    /// Ensures data integrity to prevent server-side errors
    pub fn validate_sync_data(&self, modems: &[Modem], sims: &[Sim]) -> Result<(), String> {
        // Check for duplicate equipment IDs
        let mut seen_equipment_ids = std::collections::HashSet::new();
        for modem in modems {
            if !seen_equipment_ids.insert(&modem.equipment_id) {
                return Err(format!("Duplicate equipment_id found: {}", modem.equipment_id));
            }
        }

        // Check for duplicate ICCIDs
        let mut seen_iccids = std::collections::HashSet::new();
        for sim in sims {
            if !seen_iccids.insert(&sim.iccid) {
                return Err(format!("Duplicate ICCID found: {}", sim.iccid));
            }
        }

        // Validate equipment IDs are not empty
        for modem in modems {
            if modem.equipment_id.is_empty() {
                return Err("Modem with empty equipment_id found".to_string());
            }
        }

        // Validate ICCIDs are not empty
        for sim in sims {
            if sim.iccid.is_empty() {
                return Err("SIM with empty ICCID found".to_string());
            }
        }

        Ok(())
    }

    /// Create a checkpoint string for logging/debugging
    ///
    /// Example: "session-abc123|modems=87|sims=87|2025-01-02T12:34:56Z"
    pub fn create_checkpoint(&self, modems: &[Modem], sims: &[Sim]) -> String {
        format!(
            "{}|modems={}|sims={}|{}",
            self.session_id,
            modems.len(),
            sims.len(),
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
        )
    }

    /// Get statistics about sync state
    pub fn get_stats(&self) -> SyncStats {
        SyncStats {
            session_id: self.session_id.clone(),
            last_full_sync: self.last_full_sync.map(|t| t.elapsed()),
            last_sync: self.last_sync.map(|t| t.elapsed()),
            consecutive_failures: self.consecutive_failures,
            needs_full_sync: self.needs_full_sync(),
        }
    }
}

/// Statistics about sync manager state
#[derive(Debug)]
pub struct SyncStats {
    pub session_id: String,
    pub last_full_sync: Option<Duration>,
    pub last_sync: Option<Duration>,
    pub consecutive_failures: u32,
    pub needs_full_sync: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state_needs_full_sync() {
        let sm = SyncManager::new("test-session".to_string(), 300);
        assert!(sm.needs_full_sync());
        assert_eq!(sm.get_sync_mode(), SyncMode::Full);
    }

    #[test]
    fn test_incremental_after_success() {
        let mut sm = SyncManager::new("test-session".to_string(), 300);

        sm.record_success(SyncMode::Full);
        assert!(!sm.needs_full_sync());
        assert_eq!(sm.get_sync_mode(), SyncMode::Incremental);
    }

    #[test]
    fn test_failures_trigger_full_sync() {
        let mut sm = SyncManager::new("test-session".to_string(), 300);

        sm.record_success(SyncMode::Full);
        assert!(!sm.needs_full_sync());

        // Simulate failures
        for _ in 0..3 {
            sm.record_failure(SyncMode::Incremental, &std::io::Error::new(std::io::ErrorKind::Other, "test"));
        }

        assert!(sm.needs_full_sync());
    }
}
