-- Runtime code owns updated_at values, so the trigger duplicated every modem UPDATE.
DROP TRIGGER IF EXISTS update_modems_timestamp;

-- daemon_health is always selected by its primary key. Indexing last_heartbeat only
-- amplified every heartbeat write and was never used by an application query.
DROP INDEX IF EXISTS idx_daemon_health_heartbeat;
