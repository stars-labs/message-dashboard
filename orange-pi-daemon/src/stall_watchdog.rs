//! Restart the daemon when the collection loop stops making progress.
//!
//! A hung process never triggers `Restart=always`, so a stalled collection loop
//! must make the daemon exit itself.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A healthy cycle takes 6–18 s across 93 modems, far below this.
pub const STALL_AFTER: Duration = Duration::from_secs(300);

/// Startup grace. `preStart` already waits for USB to settle, but the first
/// cycle still has to enumerate every modem.
pub const STARTUP_GRACE: Duration = Duration::from_secs(600);

/// `last_read_age` is `None` before the first successful cycle, which is only a
/// stall once the startup grace has passed — otherwise the watchdog would kill
/// the daemon while it is still enumerating.
pub fn should_restart(uptime: Duration, last_read_age: Option<Duration>) -> bool {
    match last_read_age {
        Some(age) => age >= STALL_AFTER,
        None => uptime >= STARTUP_GRACE,
    }
}

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

/// Unix seconds of the last completed read cycle; zero means never. Atomic so
/// the watchdog needs nothing from the async runtime.
#[derive(Debug, Clone, Default)]
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
        .map_or(0, |d| d.as_secs())
}

/// Runs on its own OS thread: a stall can be every tokio worker spinning, which
/// would starve a tokio-based watchdog too.
#[expect(
    clippy::print_stderr,
    reason = "the exit notice must not depend on the logging pipeline of a stalled process; systemd puts stderr in the journal"
)]
pub fn spawn(heartbeat: Heartbeat) -> std::io::Result<()> {
    let started = Instant::now();
    std::thread::Builder::new()
        .name("stall-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let (uptime, age) = (started.elapsed(), heartbeat.age());
            if should_restart(uptime, age) {
                eprintln!(
                    "stall watchdog: {}. Exiting so systemd restarts the daemon.",
                    stall_reason(uptime, age)
                );
                std::process::exit(1);
            }
        })
        .map(|_| ())
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
        assert!(should_restart(MINUTE * 60, Some(MINUTE * 157)));
        assert!(should_restart(MINUTE * 60, Some(STALL_AFTER)));
        assert!(!should_restart(
            MINUTE * 60,
            Some(STALL_AFTER.checked_sub(Duration::from_secs(1)).unwrap())
        ));
    }

    #[test]
    fn startup_is_given_time_to_enumerate() {
        assert!(!should_restart(MINUTE, None));
        assert!(!should_restart(
            STARTUP_GRACE.checked_sub(Duration::from_secs(1)).unwrap(),
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
