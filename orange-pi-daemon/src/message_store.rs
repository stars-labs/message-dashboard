// Local message store using SQLite for reliable message handling
// This ensures messages are:
// 1. Saved locally before deletion from SIM
// 2. Uploaded reliably even if API is down
// 3. Deduplicated to prevent re-uploads
// 4. Deleted from SIM only after successful processing

use crate::types::Message;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tracing::{debug, info, warn};

#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub id: i64,
    pub source_message_id: String,
    pub message: Message,
    pub modem_id: String,
    pub sms_path: String,
    pub status: MessageStatus,
    pub attempts: u32,
    pub lease_token: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MessageStatus {
    Pending,   // Waiting to be uploaded
    Uploading, // Currently being uploaded
    Uploaded,  // Successfully uploaded to API
    Failed,    // Upload failed (will retry)
    Deleted,   // Deleted from SIM card
}

pub struct MessageStore {
    conn: Arc<Mutex<Connection>>,
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|name| name == column))
}

impl MessageStore {
    /// Create a new message store with SQLite backend
    pub fn new(db_path: &str) -> Result<Self> {
        // Create directory if it doesn't exist
        if let Some(parent) = Path::new(db_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path).context("Failed to open SQLite database")?;

        // Enable WAL mode for better concurrency
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = 10000;
             PRAGMA temp_store = MEMORY;",
        )?;

        // Create tables
        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_iccid TEXT NOT NULL,
                phone_number TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                direction TEXT NOT NULL,
                modem_id TEXT NOT NULL,
                sms_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER DEFAULT 0,
                source_message_id TEXT UNIQUE,
                next_attempt_at TIMESTAMP,
                lease_token TEXT,
                lease_expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                uploaded_at TIMESTAMP,
                deleted_at TIMESTAMP,
                error TEXT,
                UNIQUE(phone_iccid, timestamp, content)
            )",
            [],
        )?;

        // Existing databases are upgraded in place. The server never creates an
        // ID for these rows: each local row receives its durable identity here.
        for (column, definition) in [
            ("source_message_id", "TEXT"),
            ("next_attempt_at", "TIMESTAMP"),
            ("lease_token", "TEXT"),
            ("lease_expires_at", "TIMESTAMP"),
        ] {
            if !has_column(&conn, "messages", column)? {
                conn.execute(
                    &format!("ALTER TABLE messages ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        let missing_ids = {
            let mut stmt =
                conn.prepare("SELECT id FROM messages WHERE source_message_id IS NULL")?;
            let ids = stmt
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        for id in missing_ids {
            conn.execute(
                "UPDATE messages SET source_message_id = ?1 WHERE id = ?2",
                params![uuid::Uuid::new_v4().to_string(), id],
            )?;
        }
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_message_id ON messages(source_message_id)",
            [],
        )?;
        conn.execute(
            "UPDATE messages SET status = 'pending' WHERE status = 'failed'",
            [],
        )?;
        conn.execute(
            "UPDATE messages SET status = 'in_flight' WHERE status = 'uploading'",
            [],
        )?;
        // `uploading` predates leases. Such rows have no lease expiry, so they
        // would otherwise never satisfy the in-flight recovery predicate.
        conn.execute(
            "UPDATE messages
             SET status = 'pending', lease_token = NULL, lease_expires_at = NULL
             WHERE status = 'in_flight' AND lease_expires_at IS NULL",
            [],
        )?;

        // Create indexes
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_status ON messages(status)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_modem_sms ON messages(modem_id, sms_path)",
            [],
        )?;

        // Create SIM storage tracking table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sim_storage (
                iccid TEXT PRIMARY KEY,
                total_messages INTEGER DEFAULT 0,
                deleted_messages INTEGER DEFAULT 0,
                last_check TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_full BOOLEAN DEFAULT 0
            )",
            [],
        )?;

        // Create multipart SMS segments table for buffering incomplete messages
        conn.execute(
            "CREATE TABLE IF NOT EXISTS multipart_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_iccid TEXT NOT NULL,
                sender TEXT NOT NULL,
                ref_id INTEGER NOT NULL,
                total_parts INTEGER NOT NULL,
                part_number INTEGER NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                sms_storage TEXT NOT NULL DEFAULT 'ME',
                sms_index INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(phone_iccid, ref_id, part_number)
            )",
            [],
        )?;

        // Existing databases predate storage-aware ME/SM polling. Their buffered
        // segments came from EC20's MT view, which is an alias for ME.
        let has_sms_storage = {
            let mut stmt = conn.prepare("PRAGMA table_info(multipart_segments)")?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            columns.iter().any(|column| column == "sms_storage")
        };
        if !has_sms_storage {
            conn.execute(
                "ALTER TABLE multipart_segments
                 ADD COLUMN sms_storage TEXT NOT NULL DEFAULT 'ME'",
                [],
            )?;
        }

        // Create index for querying message groups
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_multipart_group
             ON multipart_segments(phone_iccid, sender, ref_id, total_parts)",
            [],
        )?;

        info!("📊 Message store initialized at: {}", db_path);

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Store a message from SIM card (returns true if new, false if duplicate)
    pub fn store_message(&self, message: &Message, modem_id: &str, sms_path: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();

        // Check for duplicate first (same logic as server - within 10 seconds)
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM messages
             WHERE phone_iccid = ?1
               AND content = ?2
               AND datetime(timestamp) BETWEEN datetime(?3, '-10 seconds')
                                            AND datetime(?3, '+10 seconds')",
                params![&message.phone_iccid, &message.content, &message.timestamp],
                |row| row.get(0),
            )
            .optional()?;

        if existing.is_some() {
            debug!(
                "Duplicate message found, skipping: {} from {}",
                &message.content[..20.min(message.content.len())],
                &message.phone_iccid
            );
            return Ok(false);
        }

        // Insert new message
        conn.execute(
            "INSERT INTO messages
             (source_message_id, phone_iccid, phone_number, content, timestamp, direction, modem_id, sms_path, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')",
            params![
                uuid::Uuid::new_v4().to_string(),
                &message.phone_iccid,
                &message.phone_number,
                &message.content,
                &message.timestamp,
                &message.direction,
                modem_id,
                sms_path,
            ],
        )?;

        debug!("Stored new message from ICCID: {}", &message.phone_iccid);

        // Update SIM storage count
        conn.execute(
            "INSERT INTO sim_storage (iccid, total_messages)
             VALUES (?1, 1)
             ON CONFLICT(iccid) DO UPDATE SET
                total_messages = total_messages + 1,
                last_check = CURRENT_TIMESTAMP",
            params![&message.phone_iccid],
        )?;

        Ok(true)
    }

    /// Get pending messages for upload (batched)
    pub fn get_pending_messages(&self, limit: usize) -> Result<Vec<(i64, Message)>> {
        let conn = self.conn.lock().unwrap();

        // First log what we have in the database
        let mut count_stmt =
            conn.prepare("SELECT status, COUNT(*) FROM messages GROUP BY status")?;
        if let Ok(counts) = count_stmt.query_map(params![], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
        }) {
            for count in counts.flatten() {
                debug!("Message counts by status: {} = {}", count.0, count.1);
            }
        }

        let mut stmt = conn.prepare(
            "SELECT id, phone_iccid, phone_number, content, timestamp, direction
             FROM messages
             WHERE status IN ('pending', 'failed')
               AND attempts < 5
               AND content IS NOT NULL
               AND content != ''
               AND id NOT IN (
                   SELECT id FROM messages
                   WHERE status IN ('uploaded', 'uploading')
                   AND uploaded_at > datetime('now', '-1 hour')
               )
             ORDER BY created_at ASC
             LIMIT ?1",
        )?;

        let messages = stmt
            .query_map(params![limit], |row| {
                Ok((
                    row.get(0)?,
                    Message {
                        phone_iccid: row.get(1)?,
                        phone_number: row.get(2)?,
                        content: row.get(3)?,
                        timestamp: row.get(4)?,
                        direction: row.get(5)?,
                    },
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(messages)
    }

    /// Atomically lease due work. A crashed uploader becomes eligible again when
    /// its lease expires; attempts are diagnostic only and never exhaust retries.
    pub fn claim_messages(&self, limit: usize, lease_seconds: u64) -> Result<Vec<StoredMessage>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let lease_token = uuid::Uuid::new_v4().to_string();
        let lease_interval = format!("+{} seconds", lease_seconds);
        let ids = {
            let mut stmt = tx.prepare(
                "SELECT id FROM messages
                 WHERE content IS NOT NULL AND content != ''
                   AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
                     OR (status = 'in_flight' AND lease_expires_at <= CURRENT_TIMESTAMP))
                 ORDER BY created_at ASC LIMIT ?1",
            )?;
            let ids = stmt
                .query_map(params![limit], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        let mut claimed = Vec::with_capacity(ids.len());
        for id in ids {
            tx.execute(
                "UPDATE messages SET status = 'in_flight', attempts = attempts + 1,
                 lease_token = ?1, lease_expires_at = datetime('now', ?2), next_attempt_at = NULL
                 WHERE id = ?3",
                params![lease_token, lease_interval, id],
            )?;
            claimed.push(tx.query_row(
                "SELECT id, source_message_id, phone_iccid, phone_number, content, timestamp, direction, modem_id, sms_path, attempts, lease_token
                 FROM messages WHERE id = ?1",
                params![id],
                |row| Ok(StoredMessage {
                    id: row.get(0)?, source_message_id: row.get(1)?,
                    message: Message { phone_iccid: row.get(2)?, phone_number: row.get(3)?, content: row.get(4)?, timestamp: row.get(5)?, direction: row.get(6)? },
                    modem_id: row.get(7)?, sms_path: row.get(8)?, status: MessageStatus::Uploading,
                    attempts: row.get(9)?, lease_token: row.get(10)?,
                }),
            )?);
        }
        tx.commit()?;
        Ok(claimed)
    }

    pub fn acknowledge_uploaded(&self, messages: &[StoredMessage]) -> Result<()> {
        self.finish_leases(messages, "uploaded", None)
    }

    pub fn reject_messages(&self, messages: &[StoredMessage], error: &str) -> Result<()> {
        self.finish_leases(messages, "dead_letter", Some(error))
    }

    fn finish_leases(
        &self,
        messages: &[StoredMessage],
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for message in messages {
            tx.execute(
                "UPDATE messages SET status = ?1, uploaded_at = CASE WHEN ?1 = 'uploaded' THEN CURRENT_TIMESTAMP ELSE uploaded_at END,
                 error = ?2, lease_token = NULL, lease_expires_at = NULL
                 WHERE source_message_id = ?3 AND lease_token = ?4 AND status = 'in_flight'",
                params![status, error, message.source_message_id, message.lease_token],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn return_to_pending(&self, messages: &[StoredMessage], error: &str) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for message in messages {
            let delay = (2_i64.pow(message.attempts.min(8))).min(300);
            tx.execute(
                "UPDATE messages SET status = 'pending', error = ?1, lease_token = NULL, lease_expires_at = NULL,
                 next_attempt_at = datetime('now', ?2)
                 WHERE source_message_id = ?3 AND lease_token = ?4 AND status = 'in_flight'",
                params![error, format!("+{delay} seconds"), message.source_message_id, message.lease_token],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Mark messages as being uploaded
    pub fn mark_uploading(&self, ids: &[i64]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;

        for id in ids {
            tx.execute(
                "UPDATE messages
                 SET status = 'uploading', attempts = attempts + 1
                 WHERE id = ?1",
                params![id],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// Mark messages as successfully uploaded
    pub fn mark_uploaded(&self, ids: &[i64]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;

        for id in ids {
            tx.execute(
                "UPDATE messages
                 SET status = 'uploaded', uploaded_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id],
            )?;
        }

        tx.commit()?;
        info!("✅ Marked {} messages as uploaded", ids.len());
        Ok(())
    }

    /// Mark messages as failed (will be retried)
    pub fn mark_failed(&self, ids: &[i64], error: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;

        for id in ids {
            tx.execute(
                "UPDATE messages
                 SET status = 'failed', error = ?2
                 WHERE id = ?1",
                params![id, error],
            )?;
        }

        tx.commit()?;
        warn!("⚠️ Marked {} messages as failed: {}", ids.len(), error);
        Ok(())
    }

    /// Get SMS paths to delete from SIM (only uploaded messages)
    pub fn get_deletable_sms(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT DISTINCT modem_id, sms_path
             FROM messages
             WHERE status = 'uploaded'
               AND deleted_at IS NULL
             LIMIT 100",
        )?;

        let paths = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(paths)
    }

    /// Mark SMS as deleted from SIM
    pub fn mark_sms_deleted(&self, modem_id: &str, sms_path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE messages
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE modem_id = ?1 AND sms_path = ?2",
            params![modem_id, sms_path],
        )?;

        // Update SIM storage count
        conn.execute(
            "UPDATE sim_storage
             SET deleted_messages = deleted_messages + 1
             WHERE iccid = (
                SELECT phone_iccid FROM messages
                WHERE modem_id = ?1 AND sms_path = ?2
                LIMIT 1
             )",
            params![modem_id, sms_path],
        )?;

        Ok(())
    }

    /// Get statistics
    pub fn get_stats(&self) -> Result<MessageStats> {
        let conn = self.conn.lock().unwrap();

        let (pending, uploading, uploaded, failed, total): (i64, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT
                    COUNT(CASE WHEN status = 'pending' THEN 1 END),
                    COUNT(CASE WHEN status = 'uploading' THEN 1 END),
                    COUNT(CASE WHEN status = 'uploaded' THEN 1 END),
                    COUNT(CASE WHEN status = 'failed' THEN 1 END),
                    COUNT(*)
                 FROM messages
                 WHERE created_at > datetime('now', '-24 hours')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;

        Ok(MessageStats {
            pending: pending as usize,
            uploading: uploading as usize,
            uploaded: uploaded as usize,
            failed: failed as usize,
            total: total as usize,
        })
    }

    /// Queue states that require different operator actions. Unlike the dashboard
    /// statistics, this covers the complete durable local queue, not only 24 hours.
    pub fn get_queue_stats(&self) -> Result<QueueStats> {
        let conn = self.conn.lock().unwrap();
        let (pending, dead_letter, in_flight, oldest_unacknowledged_age_seconds): (
            i64,
            i64,
            i64,
            Option<i64>,
        ) = conn.query_row(
            "SELECT
                COUNT(CASE WHEN status = 'pending' THEN 1 END),
                COUNT(CASE WHEN status = 'dead_letter' THEN 1 END),
                COUNT(CASE WHEN status = 'in_flight' THEN 1 END),
                MIN(CASE WHEN status IN ('pending', 'in_flight')
                  THEN CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) END)
             FROM messages",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;

        Ok(QueueStats {
            pending: pending as usize,
            dead_letter: dead_letter as usize,
            in_flight: in_flight as usize,
            oldest_unacknowledged_age_seconds: oldest_unacknowledged_age_seconds
                .map(|value| value as u64),
        })
    }

    /// Check if database has many messages for any SIM (NOT actual SIM card storage)
    pub fn check_sim_storage(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();

        // This checks DATABASE message count, NOT physical SIM card!
        let mut stmt = conn.prepare(
            "SELECT iccid
             FROM sim_storage
             WHERE (total_messages - deleted_messages) > 200",
        )?;

        let full_sims = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;

        if !full_sims.is_empty() {
            warn!(
                "⚠️ Database has >200 old messages for SIMs (NOT on physical SIM cards): {:?}",
                full_sims
            );
        }

        Ok(full_sims)
    }

    /// Clean up old uploaded and deleted messages (>7 days)
    pub fn cleanup_old_messages(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();

        let deleted = conn.execute(
            "DELETE FROM messages
             WHERE status = 'uploaded'
               AND deleted_at IS NOT NULL
               AND created_at < datetime('now', '-7 days')",
            [],
        )?;

        if deleted > 0 {
            info!("🧹 Cleaned up {} old messages", deleted);
        }

        Ok(deleted)
    }

    /// Mark old uploaded messages as having been deleted (to stop deletion attempts)
    /// This is for messages that were uploaded before the immediate deletion fix
    pub fn mark_old_uploaded_as_deleted(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();

        // Mark messages uploaded >1 hour ago as deleted (they have stale paths)
        let updated = conn.execute(
            "UPDATE messages
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE status = 'uploaded'
               AND deleted_at IS NULL
               AND uploaded_at < datetime('now', '-1 hour')",
            [],
        )?;

        if updated > 0 {
            info!(
                "✅ Marked {} old uploaded messages as deleted (stale paths)",
                updated
            );
        }

        Ok(updated)
    }
}

#[cfg(test)]
mod queue_monitoring_tests {
    use super::*;

    #[test]
    fn reports_pending_dead_letter_and_in_flight_messages_without_an_attempt_cap() {
        let store = MessageStore::new(":memory:").unwrap();
        {
            let conn = store.conn.lock().unwrap();
            for (index, (status, attempts)) in [
                ("pending", 0),
                ("pending", 8),
                ("dead_letter", 5),
                ("dead_letter", 8),
                ("in_flight", 1),
                ("uploaded", 1),
            ]
            .into_iter()
            .enumerate()
            {
                conn.execute(
                    "INSERT INTO messages (
                        phone_iccid, phone_number, content, timestamp, direction,
                        modem_id, sms_path, status, attempts
                     ) VALUES ('iccid', '10010', ?3, CURRENT_TIMESTAMP, 'received',
                               'modem', ?4, ?1, ?2)",
                    params![
                        status,
                        attempts,
                        format!("content-{index}"),
                        format!("path-{index}")
                    ],
                )
                .unwrap();
            }
        }

        let stats = store.get_queue_stats().unwrap();
        assert_eq!(stats.pending, 2);
        assert_eq!(stats.dead_letter, 2);
        assert_eq!(stats.in_flight, 1);
    }
}

#[derive(Debug)]
pub struct MessageStats {
    pub pending: usize,
    pub uploading: usize,
    pub uploaded: usize,
    pub failed: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueStats {
    pub pending: usize,
    pub dead_letter: usize,
    pub in_flight: usize,
    pub oldest_unacknowledged_age_seconds: Option<u64>,
}

impl MessageStats {
    pub fn log(&self) {
        info!(
            "📊 Message store (24h): {} pending, {} uploading, {} uploaded, {} failed (total: {})",
            self.pending, self.uploading, self.uploaded, self.failed, self.total
        );
    }
}

impl MessageStore {
    /// Get uploaded messages grouped by modem
    pub fn get_uploaded_messages_by_modem(&self) -> Result<HashMap<String, Vec<Message>>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT DISTINCT modem_id, phone_iccid, phone_number, content, timestamp, direction
             FROM messages
             WHERE status = 'uploaded'
               AND deleted_at IS NULL
             ORDER BY modem_id, created_at DESC
             LIMIT 500",
        )?;

        let mut result: HashMap<String, Vec<Message>> = HashMap::new();

        let messages = stmt.query_map([], |row| {
            let modem_id: String = row.get(0)?;
            let message = Message {
                phone_iccid: row.get(1)?,
                phone_number: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get(4)?,
                direction: row.get(5)?,
            };
            Ok((modem_id, message))
        })?;

        for msg_result in messages {
            let (modem_id, message) = msg_result?;
            result
                .entry(modem_id)
                .or_insert_with(Vec::new)
                .push(message);
        }

        Ok(result)
    }

    /// Mark message as deleted by content match
    pub fn mark_message_deleted_by_content(&self, iccid: &str, content: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE messages
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE phone_iccid = ?1
               AND content = ?2
               AND status = 'uploaded'
               AND deleted_at IS NULL",
            params![iccid, content],
        )?;

        Ok(())
    }

    /// Clean up messages with empty content that have failed multiple times
    pub fn cleanup_empty_messages(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();

        // Delete messages with empty content that have failed 3+ times
        let deleted = conn.execute(
            "DELETE FROM messages
             WHERE (content IS NULL OR content = '')
               AND attempts >= 3",
            params![],
        )?;

        if deleted > 0 {
            info!("🧹 Cleaned up {} messages with empty content", deleted);
        }

        Ok(deleted)
    }

    // ============================================================================
    // Multipart SMS segment management
    // ============================================================================

    /// Store an incomplete message part
    pub fn store_segment(
        &self,
        iccid: &str,
        sender: &str,
        ref_id: u8,
        total_parts: u8,
        part_number: u8,
        content: &str,
        timestamp: &str,
        sms_index: u32,
    ) -> Result<()> {
        self.store_segment_in_storage(
            iccid,
            sender,
            ref_id,
            total_parts,
            part_number,
            content,
            timestamp,
            "ME",
            sms_index,
        )
    }

    /// Store an incomplete message part together with its CPMS location.
    pub fn store_segment_in_storage(
        &self,
        iccid: &str,
        sender: &str,
        ref_id: u8,
        total_parts: u8,
        part_number: u8,
        content: &str,
        timestamp: &str,
        sms_storage: &str,
        sms_index: u32,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT OR REPLACE INTO multipart_segments
             (phone_iccid, sender, ref_id, total_parts, part_number, content, timestamp, sms_storage, sms_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                iccid,
                sender,
                ref_id as i64,
                total_parts as i64,
                part_number as i64,
                content,
                timestamp,
                sms_storage,
                sms_index as i64,
            ],
        )?;

        debug!(
            "Stored segment {}/{} (ref_id={}) for iccid={}",
            part_number, total_parts, ref_id, iccid
        );

        Ok(())
    }

    /// Get all parts for a message group
    /// Returns: Vec<(part_number, content, timestamp, sms_index)>
    pub fn get_segments(
        &self,
        iccid: &str,
        sender: &str,
        ref_id: u8,
        total_parts: u8,
    ) -> Result<Vec<(u8, String, String, u32)>> {
        Ok(self
            .get_segments_with_storage(iccid, sender, ref_id, total_parts)?
            .into_iter()
            .map(|(part, content, timestamp, _, index)| (part, content, timestamp, index))
            .collect())
    }

    /// Get buffered parts including their CPMS storage and index.
    pub fn get_segments_with_storage(
        &self,
        iccid: &str,
        sender: &str,
        ref_id: u8,
        total_parts: u8,
    ) -> Result<Vec<(u8, String, String, String, u32)>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT part_number, content, timestamp, sms_storage, sms_index
             FROM multipart_segments
             WHERE phone_iccid = ?1
               AND sender = ?2
               AND ref_id = ?3
               AND total_parts = ?4
             ORDER BY part_number ASC",
        )?;

        let segments = stmt
            .query_map(
                params![iccid, sender, ref_id as i64, total_parts as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u8,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get::<_, i64>(4)? as u32,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(segments)
    }

    /// Delete segments after successful assembly
    pub fn delete_segments(&self, iccid: &str, ref_id: u8) -> Result<usize> {
        let conn = self.conn.lock().unwrap();

        let deleted = conn.execute(
            "DELETE FROM multipart_segments
             WHERE phone_iccid = ?1
               AND ref_id = ?2",
            params![iccid, ref_id as i64],
        )?;

        if deleted > 0 {
            debug!(
                "Deleted {} segments for ref_id={}, iccid={}",
                deleted, ref_id, iccid
            );
        }

        Ok(deleted)
    }

    /// Get all incomplete segments (for recovery on startup)
    /// Returns buffered segment metadata including CPMS storage and index.
    pub fn get_all_segments(
        &self,
    ) -> Result<Vec<(String, String, u8, u8, u8, String, String, String, u32)>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT phone_iccid, sender, ref_id, total_parts, part_number, content, timestamp, sms_storage, sms_index
             FROM multipart_segments
             ORDER BY phone_iccid, ref_id, part_number",
        )?;

        let segments = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, i64>(2)? as u8,
                    row.get::<_, i64>(3)? as u8,
                    row.get::<_, i64>(4)? as u8,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get::<_, i64>(8)? as u32,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(segments)
    }

    /// Cleanup segments older than timeout_secs
    /// Returns count of segments deleted
    pub fn cleanup_old_segments(&self, timeout_secs: i64) -> Result<usize> {
        let conn = self.conn.lock().unwrap();

        let deleted = conn.execute(
            "DELETE FROM multipart_segments
             WHERE datetime(created_at) < datetime('now', ?1 || ' seconds')",
            params![format!("-{}", timeout_secs)],
        )?;

        if deleted > 0 {
            warn!(
                "🧹 Cleaned up {} expired multipart segments (timeout={}s)",
                deleted, timeout_secs
            );
        }

        Ok(deleted)
    }
}
