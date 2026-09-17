-- Let an incremental sync see outbound status changes.
--
-- Incremental sync pages on `created_at`, the ingestion clock. A sent message's
-- row is written once and its `status` moves later (sending → processing →
-- sent/failed/unknown), so the change was never delivered: the dashboard showed
-- 等待发送 forever and the operator could not tell whether an SMS went out.
--
-- /api/messages now also asks for outbound rows whose `updated_at` moved inside
-- the sync window. This index keeps that query off a table scan.
CREATE INDEX IF NOT EXISTS idx_messages_outbound_updated
    ON messages(type, updated_at);
