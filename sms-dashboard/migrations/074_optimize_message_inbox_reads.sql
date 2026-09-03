-- Dashboard polling uses created_at as its ingestion cursor. Keep the hot query
-- proportional to messages received since the previous poll, not table history.
CREATE INDEX idx_messages_user_created
ON messages(purpose, created_at DESC, id DESC);

CREATE INDEX idx_messages_iccid_user_created
ON messages(phone_iccid, purpose, created_at DESC, id DESC);

PRAGMA optimize;
