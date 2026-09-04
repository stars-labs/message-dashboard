-- OTP polling keeps its two-second response time while reading only messages
-- ingested after the previous poll. messages.id is the daemon-assigned
-- source_message_id and provides a stable tie-breaker for equal timestamps.
CREATE INDEX idx_messages_otp_cursor
ON messages(phone_iccid, created_at, id)
WHERE type = 'received' AND verification_code IS NOT NULL;

PRAGMA optimize;
