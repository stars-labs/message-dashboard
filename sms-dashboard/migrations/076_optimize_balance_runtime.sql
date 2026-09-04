ALTER TABLE sim_balance_checks ADD COLUMN deadline_at TIMESTAMP;

UPDATE sim_balance_checks
SET deadline_at = datetime(
  COALESCE(sent_at, requested_at),
  '+' || (
    SELECT p.response_window_minutes
    FROM sim_balance_profiles p
    WHERE p.id = sim_balance_checks.profile_id
  ) || ' minutes'
)
WHERE status = 'awaiting_response';

CREATE INDEX idx_balance_checks_status_deadline
ON sim_balance_checks(status, deadline_at);

CREATE INDEX idx_balance_web_jobs_pending_claim
ON sim_balance_web_jobs(created_at, id)
WHERE status = 'pending' AND attempts < 3;

PRAGMA optimize;
