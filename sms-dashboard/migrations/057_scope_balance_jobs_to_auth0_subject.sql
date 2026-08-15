-- Bind Dashboard-created balance work to the Auth0 user that requested it.
-- NULL is reserved for legacy API-key control jobs; desktop Auth0 runners must
-- never claim those jobs, and legacy runners must never claim user-owned jobs.

ALTER TABLE sim_balance_checks ADD COLUMN requested_by_subject TEXT;

CREATE INDEX IF NOT EXISTS idx_balance_checks_owner_status
    ON sim_balance_checks(requested_by_subject, status, requested_at DESC);
