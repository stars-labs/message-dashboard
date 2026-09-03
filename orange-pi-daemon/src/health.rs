use serde::Serialize;
use std::time::Instant;

pub const HEALTH_SCHEMA_VERSION: u8 = 3;

#[derive(Debug, Clone, Copy)]
pub enum HealthTask {
    ModemReader,
    DeviceSync,
    OutboundPoll,
    MessageUploader,
}

#[derive(Debug, Clone, Default)]
struct TaskState {
    last_success: Option<Instant>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct QueueHealthSnapshot {
    pub pending: usize,
    pub in_flight: usize,
    pub dead_letter: usize,
    pub oldest_unacknowledged_age_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthSnapshot {
    pub schema_version: u8,
    pub session_id: String,
    pub version: String,
    pub uptime_seconds: u64,
    pub last_message_read_success_age_seconds: Option<u64>,
    pub last_upload_success_age_seconds: Option<u64>,
    pub queue: QueueHealthSnapshot,
}

pub struct HealthTracker {
    started_at: Instant,
    session_id: String,
    version: String,
    modem_reader: TaskState,
    message_uploader: TaskState,
}

impl HealthTracker {
    pub fn new(session_id: String, version: String, _discovered_modems: usize) -> Self {
        Self {
            started_at: Instant::now(),
            session_id,
            version,
            modem_reader: TaskState::default(),
            message_uploader: TaskState::default(),
        }
    }

    pub fn record_attempt(&mut self, _task: HealthTask) {}

    pub fn record_success(&mut self, task: HealthTask) {
        match task {
            HealthTask::ModemReader => self.modem_reader.last_success = Some(Instant::now()),
            HealthTask::MessageUploader => {
                self.message_uploader.last_success = Some(Instant::now())
            }
            HealthTask::DeviceSync | HealthTask::OutboundPoll => {}
        }
    }

    pub fn record_failure(&mut self, _task: HealthTask, _error: impl ToString) {}
    pub fn set_modem_counts(
        &mut self,
        _discovered: usize,
        _responsive: usize,
        _sim_readable: usize,
    ) {
    }
    pub fn set_in_flight_uploads(&mut self, _count: usize) {}

    pub fn queue_snapshot(
        &self,
        pending: usize,
        dead_letter: usize,
        in_flight: usize,
        oldest: Option<u64>,
    ) -> QueueHealthSnapshot {
        QueueHealthSnapshot {
            pending,
            in_flight,
            dead_letter,
            oldest_unacknowledged_age_seconds: oldest,
        }
    }

    pub fn snapshot(&self, queue: QueueHealthSnapshot) -> HealthSnapshot {
        HealthSnapshot {
            schema_version: HEALTH_SCHEMA_VERSION,
            session_id: self.session_id.clone(),
            version: self.version.clone(),
            uptime_seconds: self.started_at.elapsed().as_secs(),
            last_message_read_success_age_seconds: self
                .modem_reader
                .last_success
                .map(|time| time.elapsed().as_secs()),
            last_upload_success_age_seconds: self
                .message_uploader
                .last_success
                .map(|time| time.elapsed().as_secs()),
            queue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_only_the_v3_delivery_observer_contract() {
        let mut tracker = HealthTracker::new("session".into(), "8.0.0".into(), 93);
        tracker.record_success(HealthTask::ModemReader);
        tracker.record_success(HealthTask::MessageUploader);
        let value =
            serde_json::to_value(tracker.snapshot(tracker.queue_snapshot(2, 1, 3, Some(45))))
                .unwrap();
        assert_eq!(value["schema_version"], 3);
        assert_eq!(value["queue"]["dead_letter"], 1);
        assert!(value.get("tasks").is_none());
        assert!(value["last_upload_success_age_seconds"].is_number());
    }
}
