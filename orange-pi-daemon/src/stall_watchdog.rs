//! Restart the daemon when the collection loop stops making progress.
//!
//! On 2026-09-18 the kernel disabled a USB root port ("disabled by hub (EMI?)")
//! and re-enumerated every modem on that bus. The daemon neither recovered nor
//! died: it stopped reading SMS and stopped sending heartbeats, yet the process
//! stayed alive, so `Restart=always` never fired. Collection was down for two
//! hours and thirty-seven minutes until someone restarted it by hand.
//!
//! A hung process is worse than a dead one. This turns "silent until a human
//! notices" into "restarted within a few minutes", which is the behaviour the
//! unit file already expects.

use std::time::Duration;

/// How long the reader may go without a completed cycle before this is a stall.
/// A healthy cycle takes 6–18 s across 93 modems; a slow one under load is
/// still far below this.
pub const STALL_AFTER: Duration = Duration::from_secs(300);

/// Startup grace. `preStart` already waits for USB to settle, but the first
/// cycle still has to enumerate every modem.
pub const STARTUP_GRACE: Duration = Duration::from_secs(600);

/// Whether the daemon should exit and let systemd restart it.
///
/// `last_read_age` is `None` before the first successful cycle, which is only a
/// stall once the startup grace has passed — otherwise the watchdog would kill
/// the daemon while it is still enumerating.
pub fn should_restart(uptime: Duration, last_read_age: Option<Duration>) -> bool {
    match last_read_age {
        Some(age) => age >= STALL_AFTER,
        None => uptime >= STARTUP_GRACE,
    }
}

/// What to write to the journal before exiting, so the restart is not a mystery.
pub fn stall_reason(uptime: Duration, last_read_age: Option<Duration>) -> String {
    match last_read_age {
        Some(age) => format!(
            "no completed modem read cycle for {}s (uptime {}s)",
            age.as_secs(),
            uptime.as_secs()
        ),
        None => format!(
            "no modem read cycle has completed in the {}s since start",
            uptime.as_secs()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn a_healthy_cycle_never_restarts() {
        assert!(!should_restart(MINUTE * 60, Some(Duration::from_secs(18))));
    }

    #[test]
    fn a_stalled_reader_restarts() {
        // The 2026-09-18 outage: alive, quiet, and useless for 2h37m.
        assert!(should_restart(MINUTE * 60, Some(MINUTE * 157)));
        assert!(should_restart(MINUTE * 60, Some(STALL_AFTER)));
        assert!(!should_restart(
            MINUTE * 60,
            Some(STALL_AFTER - Duration::from_secs(1))
        ));
    }

    #[test]
    fn startup_is_given_time_to_enumerate() {
        assert!(!should_restart(MINUTE, None));
        assert!(!should_restart(
            STARTUP_GRACE - Duration::from_secs(1),
            None
        ));
        assert!(should_restart(STARTUP_GRACE, None));
    }

    #[test]
    fn the_reason_names_what_stalled() {
        assert!(stall_reason(MINUTE * 60, Some(MINUTE * 10)).contains("600s"));
        assert!(stall_reason(MINUTE * 20, None).contains("no modem read cycle has completed"));
    }
}
