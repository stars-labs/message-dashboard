use serde::Serialize;
use std::time::{Duration, Instant};

const IN_FLIGHT_UPLOAD_TIMEOUT: Duration = Duration::from_secs(90);

pub const HEALTH_SCHEMA_VERSION: u8 = 2;

#[derive(Debug, Clone, Copy)]
pub enum HealthTask {
    ModemReader,
    DeviceSync,
    OutboundPoll,
    MessageUploader,
}

#[derive(Debug, Clone, Default)]
struct TaskState {
    last_attempt: Option<Instant>,
    last_success: Option<Instant>,
    consecutive_failures: u32,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskHealthSnapshot {
    pub last_attempt_age_seconds: Option<u64>,
    pub last_success_age_seconds: Option<u64>,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskSnapshots {
    pub modem_reader: TaskHealthSnapshot,
    pub device_sync: TaskHealthSnapshot,
    pub outbound_poll: TaskHealthSnapshot,
    pub message_uploader: TaskHealthSnapshot,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct QueueHealthSnapshot {
    pub retryable: usize,
    pub attempts_exhausted: usize,
    pub stuck_uploading: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ModemHealthSnapshot {
    pub discovered: usize,
    pub responsive: usize,
    pub sim_readable: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthSnapshot {
    pub schema_version: u8,
    pub session_id: String,
    pub version: String,
    pub uptime_seconds: u64,
    pub tasks: TaskSnapshots,
    pub queue: QueueHealthSnapshot,
    pub modems: ModemHealthSnapshot,
}

pub struct HealthTracker {
    started_at: Instant,
    session_id: String,
    version: String,
    modem_reader: TaskState,
    device_sync: TaskState,
    outbound_poll: TaskState,
    message_uploader: TaskState,
    in_flight_uploads: Option<(usize, Instant)>,
    modems: ModemHealthSnapshot,
}

impl HealthTracker {
    pub fn new(session_id: String, version: String, discovered_modems: usize) -> Self {
        Self {
            started_at: Instant::now(),
            session_id,
            version,
            modem_reader: TaskState::default(),
            device_sync: TaskState::default(),
            outbound_poll: TaskState::default(),
            message_uploader: TaskState::default(),
            in_flight_uploads: None,
            modems: ModemHealthSnapshot {
                discovered: discovered_modems,
                responsive: 0,
                sim_readable: 0,
            },
        }
    }

    fn task_mut(&mut self, task: HealthTask) -> &mut TaskState {
        match task {
            HealthTask::ModemReader => &mut self.modem_reader,
            HealthTask::DeviceSync => &mut self.device_sync,
            HealthTask::OutboundPoll => &mut self.outbound_poll,
            HealthTask::MessageUploader => &mut self.message_uploader,
        }
    }

    pub fn record_attempt(&mut self, task: HealthTask) {
        self.task_mut(task).last_attempt = Some(Instant::now());
    }

    pub fn record_success(&mut self, task: HealthTask) {
        let now = Instant::now();
        let state = self.task_mut(task);
        state.last_attempt = Some(now);
        state.last_success = Some(now);
        state.consecutive_failures = 0;
        state.last_error = None;
    }

    pub fn record_failure(&mut self, task: HealthTask, error: impl ToString) {
        let state = self.task_mut(task);
        state.last_attempt = Some(Instant::now());
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        state.last_error = Some(error.to_string().chars().take(500).collect());
    }

    pub fn set_modem_counts(&mut self, discovered: usize, responsive: usize, sim_readable: usize) {
        self.modems = ModemHealthSnapshot {
            discovered,
            responsive,
            sim_readable,
        };
    }

    pub fn set_in_flight_uploads(&mut self, count: usize) {
        self.in_flight_uploads = (count > 0).then(|| (count, Instant::now()));
    }

    pub fn queue_snapshot(
        &self,
        retryable: usize,
        attempts_exhausted: usize,
        uploading: usize,
    ) -> QueueHealthSnapshot {
        let active_uploads = self
            .in_flight_uploads
            .filter(|(_, started_at)| started_at.elapsed() <= IN_FLIGHT_UPLOAD_TIMEOUT)
            .map(|(count, _)| count)
            .unwrap_or(0);
        QueueHealthSnapshot {
            retryable,
            attempts_exhausted,
            stuck_uploading: uploading.saturating_sub(active_uploads),
        }
    }

    pub fn snapshot(&self, queue: QueueHealthSnapshot) -> HealthSnapshot {
        HealthSnapshot {
            schema_version: HEALTH_SCHEMA_VERSION,
            session_id: self.session_id.clone(),
            version: self.version.clone(),
            uptime_seconds: self.started_at.elapsed().as_secs(),
            tasks: TaskSnapshots {
                modem_reader: task_snapshot(&self.modem_reader),
                device_sync: task_snapshot(&self.device_sync),
                outbound_poll: task_snapshot(&self.outbound_poll),
                message_uploader: task_snapshot(&self.message_uploader),
            },
            queue,
            modems: self.modems.clone(),
        }
    }
}

fn task_snapshot(state: &TaskState) -> TaskHealthSnapshot {
    TaskHealthSnapshot {
        last_attempt_age_seconds: state.last_attempt.map(|time| time.elapsed().as_secs()),
        last_success_age_seconds: state.last_success.map(|time| time.elapsed().as_secs()),
        consecutive_failures: state.consecutive_failures,
        last_error: state.last_error.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_success_and_resets_failures() {
        let mut tracker = HealthTracker::new("session".into(), "8.0.0".into(), 93);
        tracker.record_failure(HealthTask::ModemReader, "timeout");
        tracker.record_success(HealthTask::ModemReader);

        let snapshot = tracker.snapshot(tracker.queue_snapshot(0, 0, 0));
        assert_eq!(snapshot.tasks.modem_reader.consecutive_failures, 0);
        assert_eq!(snapshot.tasks.modem_reader.last_error, None);
        assert!(snapshot
            .tasks
            .modem_reader
            .last_success_age_seconds
            .is_some());
    }

    #[test]
    fn serializes_the_versioned_contract() {
        let mut tracker = HealthTracker::new("session".into(), "8.0.0".into(), 93);
        tracker.set_modem_counts(93, 92, 91);
        tracker.set_in_flight_uploads(2);
        let queue = tracker.queue_snapshot(12, 76, 3);
        let value = serde_json::to_value(tracker.snapshot(queue)).unwrap();

        assert_eq!(value["schema_version"], 2);
        assert_eq!(value["queue"]["retryable"], 12);
        assert_eq!(value["queue"]["attempts_exhausted"], 76);
        assert_eq!(value["queue"]["stuck_uploading"], 1);
        assert_eq!(value["modems"]["responsive"], 92);
        assert!(value["tasks"]["device_sync"].is_object());
    }

    #[test]
    fn bounds_error_messages() {
        let mut tracker = HealthTracker::new("session".into(), "8.0.0".into(), 0);
        tracker.record_failure(HealthTask::DeviceSync, "x".repeat(600));
        let snapshot = tracker.snapshot(tracker.queue_snapshot(0, 0, 0));
        assert_eq!(snapshot.tasks.device_sync.last_error.unwrap().len(), 500);
    }

    #[test]
    fn stops_masking_an_abandoned_in_flight_batch() {
        let mut tracker = HealthTracker::new("session".into(), "8.0.0".into(), 0);
        tracker.in_flight_uploads = Some((2, Instant::now() - Duration::from_secs(91)));

        assert_eq!(tracker.queue_snapshot(0, 0, 3).stuck_uploading, 3);
    }
}
