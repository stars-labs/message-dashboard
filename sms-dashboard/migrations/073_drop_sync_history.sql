-- Device reconciliation is event-driven. The daemon sends explicit removals and
-- performs a full reconciliation only at startup or after repeated failures.
-- No application code reads this audit table, so retaining it only amplifies writes.
DROP TABLE IF EXISTS sync_history;
