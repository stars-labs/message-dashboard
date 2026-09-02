-- Only outbound work can match the daemon's frequent poll and recovery queries.
-- Partial indexes keep both their read cost and ongoing write cost proportional to
-- the tiny actionable queue instead of the complete message history.
CREATE INDEX idx_messages_pending_outbound
ON messages(purpose, created_at, id)
WHERE type = 'sent' AND status = 'sending';

CREATE INDEX idx_messages_processing_outbound
ON messages(processing_session_id, updated_at)
WHERE type = 'sent' AND status = 'processing';

-- The Balance view requests the newest bounded page across all SIMs. The older
-- SIM-leading indexes cannot serve that global ordering and force a table scan.
CREATE INDEX idx_balance_checks_requested
ON sim_balance_checks(requested_at DESC);
