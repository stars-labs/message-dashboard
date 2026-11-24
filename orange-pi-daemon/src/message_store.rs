// Local message store using SQLite for reliable message handling
// This ensures messages are:
// 1. Saved locally before deletion from SIM
// 2. Uploaded reliably even if API is down
// 3. Deduplicated to prevent re-uploads
// 4. Deleted from SIM only after successful processing

use crate::identifiers::{Iccid, SmsAddress};
use crate::types::{Message, SmsStorage};
use anyhow::{Context, Result};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
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

/// Position of a local message in the upload queue; the stored text is the
/// `messages.status` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageStatus {
    Pending,
    InFlight,
    Uploaded,
    DeadLetter,
}

impl MessageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InFlight => "in_flight",
            Self::Uploaded => "uploaded",
            Self::DeadLetter => "dead_letter",
        }
    }
}

impl ToSql for MessageStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}

impl FromSql for MessageStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "pending" => Ok(Self::Pending),
            "in_flight" => Ok(Self::InFlight),
            "uploaded" => Ok(Self::Uploaded),
            "dead_letter" => Ok(Self::DeadLetter),
            other => Err(FromSqlError::Other(
                format!("unknown message status: {other}").into(),
            )),
        }
    }
}

/// A multipart SMS fragment and its physical location on the modem.
pub struct Segment<'a> {
    pub iccid: &'a Iccid,
    pub sender: &'a SmsAddress,
    pub ref_id: u8,
    pub total_parts: u8,
    pub part_number: u8,
    pub content: &'a str,
    pub timestamp: &'a str,
    pub sms_storage: SmsStorage,
    pub sms_index: u32,
}

/// Part number, content, timestamp, CPMS storage, and SMS index.
pub type StoredSegment = (u8, String, String, SmsStorage, u32);
/// ICCID, sender, reference, total parts, part number, content, timestamp,
/// CPMS storage, and SMS index, as returned for startup recovery.
pub type RecoverySegment = (
    Iccid,
    SmsAddress,
    u8,
    u8,
    u8,
    String,
    String,
    SmsStorage,
    u32,
);

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

fn configure_connection(conn: &Connection) -> Result<()> {
    // Enable WAL mode for better concurrency
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = 10000;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

fn create_messages_table(conn: &Connection) -> Result<()> {
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
    Ok(())
}

fn upgrade_messages_table(conn: &Connection) -> Result<()> {
    // Existing databases are upgraded in place. The server never creates an
    // ID for these rows: each local row receives its durable identity here.
    for (column, definition) in [
        ("source_message_id", "TEXT"),
        ("next_attempt_at", "TIMESTAMP"),
        ("lease_token", "TEXT"),
        ("lease_expires_at", "TIMESTAMP"),
    ] {
        if !has_column(conn, "messages", column)? {
            conn.execute(
                &format!("ALTER TABLE messages ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }
    let missing_ids = {
        let mut stmt = conn.prepare("SELECT id FROM messages WHERE source_message_id IS NULL")?;
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
    Ok(())
}

fn recover_message_statuses(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE messages SET status = ?1 WHERE status = 'failed'",
        params![MessageStatus::Pending],
    )?;
    conn.execute(
        "UPDATE messages SET status = ?1 WHERE status = 'uploading'",
        params![MessageStatus::InFlight],
    )?;
    // `uploading` predates leases. Such rows have no lease expiry, so they
    // would otherwise never satisfy the in-flight recovery predicate.
    conn.execute(
        "UPDATE messages
         SET status = ?1, lease_token = NULL, lease_expires_at = NULL
         WHERE status = ?2 AND lease_expires_at IS NULL",
        params![MessageStatus::Pending, MessageStatus::InFlight],
    )?;
    Ok(())
}

fn create_message_indexes(conn: &Connection) -> Result<()> {
    // Create indexes
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_status ON messages(status)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_modem_sms ON messages(modem_id, sms_path)",
        [],
    )?;
    Ok(())
}

fn create_sim_storage_table(conn: &Connection) -> Result<()> {
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
    Ok(())
}

fn create_multipart_segments_table(conn: &Connection) -> Result<()> {
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
    Ok(())
}

impl MessageStore {
    /// Create a new message store with SQLite backend
    pub fn new(db_path: &str) -> Result<Self> {
        // Create directory if it doesn't exist
        if let Some(parent) = Path::new(db_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path).context("Failed to open SQLite database")?;

        configure_connection(&conn)?;
        create_messages_table(&conn)?;
        upgrade_messages_table(&conn)?;
        recover_message_statuses(&conn)?;
        create_message_indexes(&conn)?;
        create_sim_storage_table(&conn)?;
        create_multipart_segments_table(&conn)?;

        info!("📊 Message store initialized at: {}", db_path);

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Store a message from SIM card (returns true if new, false if duplicate)
    /// Fold the write-ahead log back into the database and truncate it.
    ///
    /// `TRUNCATE` rather than the passive default: a passive checkpoint gives up
    /// when a reader is active, and under constant writes that meant never.
    pub fn checkpoint_wal(&self) -> Result<()> {
        let conn = self.conn();
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    pub fn store_message(&self, message: &Message, modem_id: &str, sms_path: &str) -> Result<bool> {
        let conn = self.conn();

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
                message.content.chars().take(20).collect::<String>(),
                &message.phone_iccid
            );
            return Ok(false);
        }

        // Insert new message
        conn.execute(
            "INSERT INTO messages
             (source_message_id, phone_iccid, phone_number, content, timestamp, direction, modem_id, sms_path, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                uuid::Uuid::new_v4().to_string(),
                &message.phone_iccid,
                &message.phone_number,
                &message.content,
                &message.timestamp,
                &message.direction,
                modem_id,
                sms_path,
                MessageStatus::Pending,
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

    /// Atomically lease due work. A crashed uploader becomes eligible again when
    /// its lease expires; attempts are diagnostic only and never exhaust retries.
    pub fn claim_messages(&self, limit: usize, lease_seconds: u64) -> Result<Vec<StoredMessage>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let lease_token = uuid::Uuid::new_v4().to_string();
        let lease_interval = format!("+{lease_seconds} seconds");
        let ids = {
            let mut stmt = tx.prepare(
                "SELECT id FROM messages
                 WHERE content IS NOT NULL AND content != ''
                   AND ((status = ?2 AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
                     OR (status = ?3 AND lease_expires_at <= CURRENT_TIMESTAMP))
                 ORDER BY created_at ASC LIMIT ?1",
            )?;
            let ids = stmt
                .query_map(
                    params![limit, MessageStatus::Pending, MessageStatus::InFlight],
                    |row| row.get::<_, i64>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        let mut claimed = Vec::with_capacity(ids.len());
        for id in ids {
            tx.execute(
                "UPDATE messages SET status = ?4, attempts = attempts + 1,
                 lease_token = ?1, lease_expires_at = datetime('now', ?2), next_attempt_at = NULL
                 WHERE id = ?3",
                params![lease_token, lease_interval, id, MessageStatus::InFlight],
            )?;
            let raw_iccid: String = tx.query_row(
                "SELECT phone_iccid FROM messages WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )?;
            // One row that predates ICCID validation must not stop the queue:
            // it is dead-lettered, where the queue alarm reports it.
            let Ok(phone_iccid) = Iccid::try_from(raw_iccid.as_str()) else {
                warn!("Dead-lettering message {id}: phone_iccid {raw_iccid:?} is not an ICCID");
                tx.execute(
                    "UPDATE messages SET status = ?1, error = ?2, lease_token = NULL, lease_expires_at = NULL
                     WHERE id = ?3",
                    params![MessageStatus::DeadLetter, "phone_iccid is not an ICCID", id],
                )?;
                continue;
            };
            claimed.push(tx.query_row(
                "SELECT id, source_message_id, phone_number, content, timestamp, direction, modem_id, sms_path, attempts, lease_token
                 FROM messages WHERE id = ?1",
                params![id],
                |row| Ok(StoredMessage {
                    id: row.get(0)?, source_message_id: row.get(1)?,
                    message: Message { phone_iccid, phone_number: row.get(2)?, content: row.get(3)?, timestamp: row.get(4)?, direction: row.get(5)? },
                    modem_id: row.get(6)?, sms_path: row.get(7)?, status: MessageStatus::InFlight,
                    attempts: row.get(8)?, lease_token: row.get(9)?,
                }),
            )?);
        }
        tx.commit()?;
        Ok(claimed)
    }

    pub fn acknowledge_uploaded(&self, messages: &[StoredMessage]) -> Result<()> {
        self.finish_leases(messages, MessageStatus::Uploaded, None)
    }

    pub fn reject_messages(&self, messages: &[StoredMessage], error: &str) -> Result<()> {
        self.finish_leases(messages, MessageStatus::DeadLetter, Some(error))
    }

    fn finish_leases(
        &self,
        messages: &[StoredMessage],
        status: MessageStatus,
        error: Option<&str>,
    ) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for message in messages {
            tx.execute(
                "UPDATE messages SET status = ?1, uploaded_at = CASE WHEN ?1 = ?5 THEN CURRENT_TIMESTAMP ELSE uploaded_at END,
                 error = ?2, lease_token = NULL, lease_expires_at = NULL
                 WHERE source_message_id = ?3 AND lease_token = ?4 AND status = ?6",
                params![
                    status,
                    error,
                    message.source_message_id,
                    message.lease_token,
                    MessageStatus::Uploaded,
                    MessageStatus::InFlight
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn return_to_pending(&self, messages: &[StoredMessage], error: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for message in messages {
            let delay = (2_i64.pow(message.attempts.min(8))).min(300);
            tx.execute(
                "UPDATE messages SET status = ?5, error = ?1, lease_token = NULL, lease_expires_at = NULL,
                 next_attempt_at = datetime('now', ?2)
                 WHERE source_message_id = ?3 AND lease_token = ?4 AND status = ?6",
                params![
                    error,
                    format!("+{delay} seconds"),
                    message.source_message_id,
                    message.lease_token,
                    MessageStatus::Pending,
                    MessageStatus::InFlight
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Get SMS paths to delete from SIM (only uploaded messages)
    pub fn get_deletable_sms(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn();

        let mut stmt = conn.prepare(
            "SELECT DISTINCT modem_id, sms_path
             FROM messages
             WHERE status = ?1
               AND deleted_at IS NULL
             LIMIT 100",
        )?;

        let paths = stmt
            .query_map(params![MessageStatus::Uploaded], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(paths)
    }

    /// Mark SMS as deleted from SIM
    pub fn mark_sms_deleted(&self, modem_id: &str, sms_path: &str) -> Result<()> {
        let conn = self.conn();

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

    /// Queue states that require different operator actions. Covers the complete
    /// durable local queue, with no age window.
    pub fn get_queue_stats(&self) -> Result<QueueStats> {
        let conn = self.conn();
        let (pending, dead_letter, in_flight, oldest_unacknowledged_age_seconds): (
            usize,
            usize,
            usize,
            Option<u64>,
        ) = conn.query_row(
            "SELECT
                COUNT(CASE WHEN status = ?1 THEN 1 END),
                COUNT(CASE WHEN status = ?2 THEN 1 END),
                COUNT(CASE WHEN status = ?3 THEN 1 END),
                MAX(CASE WHEN status IN (?1, ?3)
                  THEN MAX(0, CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER)) END)
             FROM messages",
            params![
                MessageStatus::Pending,
                MessageStatus::DeadLetter,
                MessageStatus::InFlight
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;

        Ok(QueueStats {
            pending,
            dead_letter,
            in_flight,
            oldest_unacknowledged_age_seconds,
        })
    }

    /// Check if database has many messages for any SIM (NOT actual SIM card storage)
    pub fn check_sim_storage(&self) -> Result<Vec<Iccid>> {
        let conn = self.conn();

        // This checks DATABASE message count, NOT physical SIM card!
        let mut stmt = conn.prepare(
            "SELECT iccid
             FROM sim_storage
             WHERE (total_messages - deleted_messages) > 200",
        )?;

        let full_sims = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<Iccid>, _>>()?;

        if !full_sims.is_empty() {
            warn!(
                "⚠️ Database has >200 old messages for SIMs (NOT on physical SIM cards): {:?}",
                full_sims.iter().map(Iccid::as_str).collect::<Vec<_>>()
            );
        }

        Ok(full_sims)
    }

    /// Clean up old uploaded and deleted messages (>7 days)
    pub fn cleanup_old_messages(&self) -> Result<usize> {
        let conn = self.conn();

        let deleted = conn.execute(
            "DELETE FROM messages
             WHERE status = ?1
               AND deleted_at IS NOT NULL
               AND created_at < datetime('now', '-7 days')",
            params![MessageStatus::Uploaded],
        )?;

        if deleted > 0 {
            info!("🧹 Cleaned up {} old messages", deleted);
        }

        Ok(deleted)
    }

    /// Mark old uploaded messages as having been deleted (to stop deletion attempts)
    /// This is for messages that were uploaded before the immediate deletion fix
    pub fn mark_old_uploaded_as_deleted(&self) -> Result<usize> {
        let conn = self.conn();

        // Mark messages uploaded >1 hour ago as deleted (they have stale paths)
        let updated = conn.execute(
            "UPDATE messages
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE status = ?1
               AND deleted_at IS NULL
               AND uploaded_at < datetime('now', '-1 hour')",
            params![MessageStatus::Uploaded],
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
mod duplicate_log_tests {
    use super::*;
    use crate::wire::Direction;

    #[test]
    fn logging_a_duplicate_with_multibyte_text_does_not_panic() {
        let store = MessageStore::new(":memory:").unwrap();
        let message = Message {
            phone_iccid: Iccid::try_from("89860000000000000001").unwrap(),
            phone_number: SmsAddress::from("10086"),
            content: "您的登录验证码五分钟内有效请勿泄露".to_string(),
            timestamp: "2024-01-01T12:00:00.000Z".to_string(),
            direction: Direction::Received,
        };
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_test_writer()
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            assert!(store.store_message(&message, "modem", "at:1").unwrap());
            assert!(!store.store_message(&message, "modem", "at:2").unwrap());
        });
    }
}

#[cfg(test)]
mod segment_write_tests {
    use super::*;

    fn changes(store: &MessageStore) -> i64 {
        let conn = store.conn.lock().unwrap();
        conn.query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap()
    }

    /// The AUTOINCREMENT counter. `total_changes()` does not count writes to
    /// `sqlite_sequence`, which is how a first fix passed its test while the daemon
    /// was still writing 2.6 GB an hour.
    fn sequence(store: &MessageStore) -> i64 {
        let conn = store.conn.lock().unwrap();
        conn.query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'multipart_segments'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn store_part(store: &MessageStore, content: &str, index: u32) {
        store
            .store_segment(&Segment {
                iccid: &Iccid::try_from("89860000000000000001").unwrap(),
                sender: &SmsAddress::from("10010"),
                ref_id: 84,
                total_parts: 9,
                part_number: 1,
                content,
                timestamp: "2025-10-09T01:47:57.000Z",
                sms_storage: SmsStorage::Sm,
                sms_index: index,
            })
            .unwrap();
    }

    /// The 2026-09-21 finding: an orphan part re-read on every scan must cost
    /// nothing once it is stored.
    #[test]
    fn storing_an_unchanged_segment_again_writes_nothing() {
        let store = MessageStore::new(":memory:").unwrap();
        store_part(&store, "part one", 3);
        let (changes_after_first, sequence_after_first) = (changes(&store), sequence(&store));

        for _ in 0..50 {
            store_part(&store, "part one", 3);
        }

        assert_eq!(changes(&store), changes_after_first);
        assert_eq!(sequence(&store), sequence_after_first);
    }

    #[test]
    fn a_segment_that_really_changed_is_updated() {
        let store = MessageStore::new(":memory:").unwrap();
        store_part(&store, "part one", 3);
        let before = changes(&store);

        // Same slot in the concatenation, but the SIM moved it to another index.
        store_part(&store, "part one", 7);

        assert_eq!(changes(&store), before + 1);
        let segments = store
            .get_segments_with_storage(
                &Iccid::try_from("89860000000000000001").unwrap(),
                &SmsAddress::from("10010"),
                84,
                9,
            )
            .unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].4, 7);
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

    fn insert_pending(store: &MessageStore, created_at: &str, index: usize) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO messages (
                phone_iccid, phone_number, content, timestamp, direction,
                modem_id, sms_path, status, created_at
             ) VALUES ('iccid', '10010', ?2, CURRENT_TIMESTAMP, 'received',
                       'modem', ?3, 'pending', datetime('now', ?1))",
            params![
                created_at,
                format!("content-{index}"),
                format!("path-{index}")
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_row_whose_iccid_predates_validation_is_dead_lettered_not_blocking_the_claim() {
        let store = MessageStore::new(":memory:").unwrap();
        {
            let conn = store.conn.lock().unwrap();
            for (index, iccid) in ["iccid_001", "898600520121F0517883"]
                .into_iter()
                .enumerate()
            {
                conn.execute(
                    "INSERT INTO messages (
                        source_message_id, phone_iccid, phone_number, content, timestamp,
                        direction, modem_id, sms_path, status, created_at
                     ) VALUES (?5, ?1, '10010', ?2, CURRENT_TIMESTAMP, 'received',
                               'modem', ?3, 'pending', datetime('now', ?4))",
                    params![
                        iccid,
                        format!("content-{index}"),
                        format!("path-{index}"),
                        format!("-{} minutes", 10 - index),
                        format!("source-{index}")
                    ],
                )
                .unwrap();
            }
        }

        let claimed = store.claim_messages(10, 90).unwrap();

        assert_eq!(claimed.len(), 1);
        assert_eq!(
            claimed[0].message.phone_iccid.as_str(),
            "898600520121F0517883"
        );
        let stats = store.get_queue_stats().unwrap();
        assert_eq!((stats.dead_letter, stats.in_flight), (1, 1));
    }

    #[test]
    fn reports_the_age_of_the_oldest_unacknowledged_message() {
        let store = MessageStore::new(":memory:").unwrap();
        insert_pending(&store, "-2 hours", 0);
        insert_pending(&store, "-5 minutes", 1);

        let age = store
            .get_queue_stats()
            .unwrap()
            .oldest_unacknowledged_age_seconds;

        assert!(age.is_some_and(|seconds| (7190..=7210).contains(&seconds)));
    }

    #[test]
    fn a_message_stamped_in_the_future_has_waited_no_time() {
        let store = MessageStore::new(":memory:").unwrap();
        insert_pending(&store, "+1 hour", 0);

        let age = store
            .get_queue_stats()
            .unwrap()
            .oldest_unacknowledged_age_seconds;

        assert_eq!(age, Some(0));
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueStats {
    pub pending: usize,
    pub dead_letter: usize,
    pub in_flight: usize,
    pub oldest_unacknowledged_age_seconds: Option<u64>,
}

impl MessageStore {
    /// Get uploaded messages grouped by modem
    pub fn get_uploaded_messages_by_modem(&self) -> Result<HashMap<String, Vec<Message>>> {
        let conn = self.conn();

        let mut stmt = conn.prepare(
            "SELECT DISTINCT modem_id, phone_iccid, phone_number, content, timestamp, direction
             FROM messages
             WHERE status = ?1
               AND deleted_at IS NULL
             ORDER BY modem_id, created_at DESC
             LIMIT 500",
        )?;

        let mut result: HashMap<String, Vec<Message>> = HashMap::new();

        let messages = stmt.query_map(params![MessageStatus::Uploaded], |row| {
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
            result.entry(modem_id).or_default().push(message);
        }

        Ok(result)
    }

    /// Mark message as deleted by content match
    pub fn mark_message_deleted_by_content(&self, iccid: &Iccid, content: &str) -> Result<()> {
        let conn = self.conn();

        conn.execute(
            "UPDATE messages
             SET deleted_at = CURRENT_TIMESTAMP
             WHERE phone_iccid = ?1
               AND content = ?2
               AND status = ?3
               AND deleted_at IS NULL",
            params![iccid, content, MessageStatus::Uploaded],
        )?;

        Ok(())
    }

    /// Clean up messages with empty content that have failed multiple times
    pub fn cleanup_empty_messages(&self) -> Result<usize> {
        let conn = self.conn();

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

    /// Store an incomplete message part together with its CPMS location.
    pub fn store_segment(&self, segment: &Segment<'_>) -> Result<()> {
        let Segment {
            iccid,
            sender,
            ref_id,
            total_parts,
            part_number,
            content,
            timestamp,
            sms_storage,
            sms_index,
        } = *segment;
        let conn = self.conn();

        // Look before writing. A part whose siblings never arrive stays on the SIM
        // and is re-read on every scan; `INSERT OR REPLACE` deleted and re-inserted
        // it each time even though nothing differed. By 2026-09-21 that was 664
        // orphan parts (the oldest from October 2025) rewritten every ten seconds:
        // 140 writes a second, 10.9 GB an hour onto the SD card, and an id past
        // 500 million.
        //
        // The check has to be a separate SELECT. An upsert whose DO UPDATE is
        // filtered out by a WHERE clause leaves the table alone, but this table is
        // AUTOINCREMENT, and SQLite allocates the rowid — and rewrites
        // sqlite_sequence — before it discovers the conflict. That alone was still
        // 2.6 GB an hour.
        let unchanged = conn
            .query_row(
                "SELECT 1 FROM multipart_segments
                  WHERE phone_iccid = ?1 AND ref_id = ?3 AND part_number = ?5
                    AND sender = ?2 AND total_parts = ?4 AND content = ?6
                    AND timestamp = ?7 AND sms_storage = ?8 AND sms_index = ?9",
                params![
                    iccid,
                    sender,
                    i64::from(ref_id),
                    i64::from(total_parts),
                    i64::from(part_number),
                    content,
                    timestamp,
                    sms_storage,
                    i64::from(sms_index),
                ],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if unchanged {
            return Ok(());
        }

        conn.execute(
            "INSERT INTO multipart_segments
             (phone_iccid, sender, ref_id, total_parts, part_number, content, timestamp, sms_storage, sms_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(phone_iccid, ref_id, part_number) DO UPDATE SET
                 sender = excluded.sender,
                 total_parts = excluded.total_parts,
                 content = excluded.content,
                 timestamp = excluded.timestamp,
                 sms_storage = excluded.sms_storage,
                 sms_index = excluded.sms_index,
                 created_at = CURRENT_TIMESTAMP",
            params![
                iccid,
                sender,
                i64::from(ref_id),
                i64::from(total_parts),
                i64::from(part_number),
                content,
                timestamp,
                sms_storage,
                i64::from(sms_index),
            ],
        )?;

        debug!(
            "Stored segment {}/{} (ref_id={}) for iccid={}",
            part_number, total_parts, ref_id, iccid
        );

        Ok(())
    }

    /// Get all parts for a message group
    /// Returns: Vec<(`part_number`, content, timestamp, `sms_index`)>
    pub fn get_segments(
        &self,
        iccid: &Iccid,
        sender: &SmsAddress,
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
        iccid: &Iccid,
        sender: &SmsAddress,
        ref_id: u8,
        total_parts: u8,
    ) -> Result<Vec<StoredSegment>> {
        let conn = self.conn();

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
                params![iccid, sender, i64::from(ref_id), i64::from(total_parts)],
                |row| {
                    Ok((
                        row.get::<_, u8>(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get::<_, u32>(4)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(segments)
    }

    /// Delete segments after successful assembly
    pub fn delete_segments(&self, iccid: &Iccid, ref_id: u8) -> Result<usize> {
        let conn = self.conn();

        let deleted = conn.execute(
            "DELETE FROM multipart_segments
             WHERE phone_iccid = ?1
               AND ref_id = ?2",
            params![iccid, i64::from(ref_id)],
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
    pub fn get_all_segments(&self) -> Result<Vec<RecoverySegment>> {
        let conn = self.conn();

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
                    row.get::<_, u8>(2)?,
                    row.get::<_, u8>(3)?,
                    row.get::<_, u8>(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get::<_, u32>(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(segments)
    }

    /// Cleanup segments older than `timeout_secs`
    /// Returns count of segments deleted
    pub fn cleanup_old_segments(&self, timeout_secs: i64) -> Result<usize> {
        let conn = self.conn();

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

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn statuses_are_stored_as_the_queue_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (status TEXT NOT NULL)", [])
            .unwrap();
        for (status, text) in [
            (MessageStatus::Pending, "pending"),
            (MessageStatus::InFlight, "in_flight"),
            (MessageStatus::Uploaded, "uploaded"),
            (MessageStatus::DeadLetter, "dead_letter"),
        ] {
            conn.execute("DELETE FROM t", []).unwrap();
            conn.execute("INSERT INTO t VALUES (?1)", [status]).unwrap();
            let stored: String = conn
                .query_row("SELECT status FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(stored, text);
            let read: MessageStatus = conn
                .query_row("SELECT status FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(read, status);
        }
    }

    #[test]
    fn unrecognised_stored_status_is_an_error_not_a_guess() {
        let conn = Connection::open_in_memory().unwrap();
        for text in ["uploading", "failed", ""] {
            let read: rusqlite::Result<MessageStatus> =
                conn.query_row("SELECT ?1", [text], |row| row.get(0));
            assert!(read.is_err(), "{text:?}");
        }
    }

    #[test]
    fn claimed_messages_are_in_flight_and_keep_their_direction() {
        let store = MessageStore::new(":memory:").unwrap();
        let message = Message {
            phone_iccid: Iccid::try_from("89860000000000000001").unwrap(),
            phone_number: SmsAddress::from("10010"),
            content: "content".to_string(),
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            direction: crate::wire::Direction::Received,
        };
        assert!(store.store_message(&message, "1", "at:ME:1").unwrap());
        let claimed = store.claim_messages(10, 60).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].status, MessageStatus::InFlight);
        assert_eq!(
            claimed[0].message.direction,
            crate::wire::Direction::Received
        );
        let stored: String = store
            .conn()
            .query_row("SELECT status FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, "in_flight");
    }
}
