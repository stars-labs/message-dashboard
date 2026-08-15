-- Tie each outbound claim to one daemon process. A replacement daemon can then
-- mark an interrupted claim as unknown without automatically sending it again.
ALTER TABLE messages ADD COLUMN processing_session_id TEXT;
