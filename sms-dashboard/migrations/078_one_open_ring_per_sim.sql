-- One ring, one row.
--
-- The daemon reports a ring twice in quick succession: `RING` first, then the
-- caller id a few hundred milliseconds later. Both requests decided whether the
-- call was new by reading the KV call lock, and KV reads are eventually
-- consistent, so both saw "no call" and each minted its own call id. Every
-- missed call was logged twice, and one of the two rows never got an end.
--
-- Reading D1 first was not enough either: the second request can arrive before
-- the first request's INSERT has committed. So the database arbitrates instead.
-- With this partial unique index the second INSERT loses, and the loser reads
-- back the winner's row to learn the call's identity.
--
-- The predicate covers exactly "an inbound call that is still ringing": once a
-- call is answered or finished it leaves the index, so the same SIM can ring
-- again immediately.

-- Close rows the old behaviour left open, or the index cannot be built.
UPDATE calls
   SET outcome = 'missed',
       end_reason = COALESCE(end_reason, 'stale'),
       ended_at = COALESCE(ended_at, started_at)
 WHERE outcome = 'in_progress'
   AND direction = 'inbound'
   AND answered_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_open_ring
    ON calls(iccid)
 WHERE outcome = 'in_progress' AND direction = 'inbound' AND answered_at IS NULL;
