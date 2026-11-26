UPDATE messages INDEXED BY idx_messages_pending_outbound
SET status = 'failed',
    error_message = 'Message has no recipient or SIM to send from',
    updated_at = CURRENT_TIMESTAMP
WHERE type = 'sent' AND status = 'sending'
  AND (recipient IS NULL OR phone_iccid IS NULL OR created_at IS NULL);

CREATE TRIGGER require_outbound_queue_fields_on_insert
BEFORE INSERT ON messages
WHEN NEW.type = 'sent' AND NEW.status = 'sending'
  AND (NEW.recipient IS NULL OR NEW.phone_iccid IS NULL OR NEW.created_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued outbound SMS requires recipient, phone_iccid, and created_at');
END;

CREATE TRIGGER require_outbound_queue_fields_on_update
BEFORE UPDATE OF type, status, recipient, phone_iccid, created_at ON messages
WHEN NEW.type = 'sent' AND NEW.status = 'sending'
  AND (NEW.recipient IS NULL OR NEW.phone_iccid IS NULL OR NEW.created_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Queued outbound SMS requires recipient, phone_iccid, and created_at');
END;
