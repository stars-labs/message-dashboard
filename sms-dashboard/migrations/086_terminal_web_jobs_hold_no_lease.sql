CREATE TRIGGER terminal_web_jobs_hold_no_lease_on_insert
BEFORE INSERT ON sim_balance_web_jobs
WHEN NEW.status IN ('completed', 'failed', 'stopped')
  AND (NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'A finished web job cannot hold a lease');
END;

CREATE TRIGGER terminal_web_jobs_hold_no_lease_on_update
BEFORE UPDATE OF status, lease_owner, lease_expires_at ON sim_balance_web_jobs
WHEN NEW.status IN ('completed', 'failed', 'stopped')
  AND (NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'A finished web job cannot hold a lease');
END;
