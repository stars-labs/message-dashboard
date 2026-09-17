-- Voice call history: one row per call attempt, written by server/api/calls.js.
--
-- The active call itself stays in KV (server/api/calls.js CALL_KEY) so that
-- three-second dashboard polling never reads D1. This table is written only at
-- call transitions — start, answer, end — so a busy day costs a handful of
-- writes, and it is read only when someone opens the call log.
--
-- No audio, no transcript: the voice plan forbids recording, so a call is
-- described by who, which SIM, when, and for how long.
--
-- Deliberately not foreign-keyed to sims(iccid): the log must survive a SIM
-- being removed from inventory. /api/calls/history enriches each row from
-- device_view when the SIM still exists.
CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    iccid TEXT NOT NULL,
    remote_number TEXT,
    outcome TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(outcome IN ('in_progress', 'answered', 'missed', 'rejected', 'cancelled', 'failed')),
    end_reason TEXT,
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    -- Talk time only: ended_at - answered_at. A call that never connected is 0.
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    requested_by TEXT,
    answered_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- The call log is read newest-first, either across the fleet or for one SIM.
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_iccid_started_at ON calls(iccid, started_at DESC);
