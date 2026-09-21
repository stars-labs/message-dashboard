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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// The moment the modem reader last completed a cycle, as unix seconds. Zero
/// means "never". An atomic rather than the async health tracker, so the
/// watchdog can read it without the runtime's help.
#[derive(Clone, Default)]
pub struct Heartbeat(Arc<AtomicU64>);

impl Heartbeat {
    pub fn beat(&self) {
        self.0.store(unix_now(), Ordering::Relaxed);
    }

    fn age(&self) -> Option<Duration> {
        match self.0.load(Ordering::Relaxed) {
            0 => None,
            at => Some(Duration::from_secs(unix_now().saturating_sub(at))),
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Run the watchdog on its own OS thread.
///
/// The first version was a tokio task, and on 2026-09-20 it never fired: the
/// stall it existed to catch was every runtime worker spinning, which starved
/// the watchdog along with everything else. A supervisor must not depend on
/// the thing it supervises, so this one needs nothing from the runtime.
pub fn spawn(heartbeat: Heartbeat) {
    let started = Instant::now();
    std::thread::Builder::new()
        .name("stall-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let (uptime, age) = (started.elapsed(), heartbeat.age());
            if should_restart(uptime, age) {
                // eprintln, not tracing: stderr goes straight to the journal and
                // needs no runtime either.
                eprintln!(
                    "stall watchdog: {}. Exiting so systemd restarts the daemon.",
                    stall_reason(uptime, age)
                );
                std::process::exit(1);
            }
        })
        .expect("failed to start the stall watchdog thread");
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
    fn a_heartbeat_has_no_age_until_the_first_beat() {
        let heartbeat = Heartbeat::default();
        assert!(heartbeat.age().is_none());
        heartbeat.beat();
        assert!(heartbeat.age().unwrap() < Duration::from_secs(5));
    }

    #[test]
    fn the_reason_names_what_stalled() {
        assert!(stall_reason(MINUTE * 60, Some(MINUTE * 10)).contains("600s"));
        assert!(stall_reason(MINUTE * 20, None).contains("no modem read cycle has completed"));
    }
}
