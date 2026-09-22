//! Decide when a modem that keeps timing out should be forgotten and re-probed.
//!
//! A cached modem that times out is never touched by rediscovery, which only
//! looks at USB devices with no cached port. So a wedged modem, or a cache entry
//! left pointing at the wrong port by a re-enumeration, timed out on every scan
//! forever. After enough consecutive timeouts the modem is dropped from the
//! cache; the next reconcile then probes its device again and resets it if it is
//! silent.

use std::collections::HashMap;

/// Consecutive timeouts before a modem is forgotten. A scan runs every few
/// seconds and one timeout is common under load; five in a row is not.
pub const FORGET_AFTER: u32 = 5;

#[derive(Debug, Default)]
pub struct TimeoutTracker {
    consecutive: HashMap<String, u32>,
}

impl TimeoutTracker {
    /// Record one scan's outcome for a modem. Returns true when the modem has
    /// now timed out `FORGET_AFTER` times in a row and should be forgotten; the
    /// count resets so a re-probed modem starts clean.
    pub fn record(&mut self, modem_id: &str, timed_out: bool) -> bool {
        if !timed_out {
            self.consecutive.remove(modem_id);
            return false;
        }
        let count = self.consecutive.entry(modem_id.to_string()).or_insert(0);
        *count += 1;
        if *count >= FORGET_AFTER {
            self.consecutive.remove(modem_id);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_timeout_is_tolerated() {
        let mut tracker = TimeoutTracker::default();
        assert!(!tracker.record("41", true));
    }

    #[test]
    fn a_success_in_between_resets_the_count() {
        let mut tracker = TimeoutTracker::default();
        for _ in 0..FORGET_AFTER - 1 {
            assert!(!tracker.record("41", true));
        }
        tracker.record("41", false);
        for _ in 0..FORGET_AFTER - 1 {
            assert!(!tracker.record("41", true));
        }
    }

    #[test]
    fn consecutive_timeouts_forget_the_modem_once() {
        let mut tracker = TimeoutTracker::default();
        let mut forgotten = 0;
        for _ in 0..FORGET_AFTER * 2 {
            if tracker.record("41", true) {
                forgotten += 1;
            }
        }
        // Forgotten at 5 and again at 10, never in between.
        assert_eq!(forgotten, 2);
    }

    #[test]
    fn modems_are_tracked_independently() {
        let mut tracker = TimeoutTracker::default();
        for _ in 0..FORGET_AFTER - 1 {
            tracker.record("41", true);
        }
        assert!(!tracker.record("57", true));
        assert!(tracker.record("41", true));
    }
}
