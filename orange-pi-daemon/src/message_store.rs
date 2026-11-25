// A message is saved here before it is deleted from the SIM, and deleted from
// the SIM only after upload.

use crate::identifiers::{Iccid, SmsAddress};
use crate::types::{Message, SmsStorage};
use anyhow::{Context, Result};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tracing::{debug, info, warn};

mod schema;
mod segments;

#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub source_message_id: String,
    pub message: Message,
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

#[derive(Debug)]
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

#[derive(Debug)]
pub struct MessageStore {
    conn: Arc<Mutex<Connection>>,
}

impl MessageStore {
    pub fn new(db_path: &str) -> Result<Self> {
        if let Some(parent) = Path::new(db_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path).context("Failed to open SQLite database")?;

        schema::configure_connection(&conn)?;
        schema::create_messages_table(&conn)?;
        schema::upgrade_messages_table(&conn)?;
        schema::recover_message_statuses(&conn)?;
        schema::create_message_indexes(&conn)?;
        schema::create_sim_storage_table(&conn)?;
        schema::create_multipart_segments_table(&conn)?;

        info!("📊 Message store initialized at: {}", db_path);

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `TRUNCATE` rather than the passive default: a passive checkpoint gives up
    /// when a reader is active, and under constant writes that meant never.
    pub fn checkpoint_wal(&self) -> Result<()> {
        let conn = self.conn();
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    /// Returns false for a duplicate: same ICCID and content within 10 seconds,
    /// matching the server's rule.
    pub fn store_message(&self, message: &Message, modem_id: &str, sms_path: &str) -> Result<bool> {
        let conn = self.conn();

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
        let limit = i64::try_from(limit)?;
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
                "SELECT source_message_id, phone_number, content, timestamp, direction, attempts, lease_token
                 FROM messages WHERE id = ?1",
                params![id],
                |row| Ok(StoredMessage {
                    source_message_id: row.get(0)?,
                    message: Message { phone_iccid, phone_number: row.get(1)?, content: row.get(2)?, timestamp: row.get(3)?, direction: row.get(4)? },
                    attempts: row.get(5)?, lease_token: row.get(6)?,
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

    /// Queue states that require different operator actions. Covers the complete
    /// durable local queue, with no age window.
    pub fn get_queue_stats(&self) -> Result<QueueStats> {
        let conn = self.conn();
        let (pending, dead_letter, in_flight, oldest_unacknowledged_age_seconds): (
            i64,
            i64,
            i64,
            Option<i64>,
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
            pending: usize::try_from(pending)?,
            dead_letter: usize::try_from(dead_letter)?,
            in_flight: usize::try_from(in_flight)?,
            oldest_unacknowledged_age_seconds: oldest_unacknowledged_age_seconds
                .map(u64::try_from)
                .transpose()?,
        })
    }

    /// ICCIDs with more than 200 undeleted rows in this database; says nothing
    /// about the physical SIM's storage.
    pub fn iccids_over_local_message_limit(&self) -> Result<Vec<Iccid>> {
        let conn = self.conn();

        let mut stmt = conn.prepare(
            "SELECT iccid
             FROM sim_storage
             WHERE (total_messages - deleted_messages) > 200",
        )?;

        let iccids = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<Iccid>, _>>()?;

        if !iccids.is_empty() {
            warn!(
                "⚠️ Database has >200 old messages for SIMs (NOT on physical SIM cards): {:?}",
                iccids.iter().map(Iccid::as_str).collect::<Vec<_>>()
            );
        }

        Ok(iccids)
    }

    /// Uploaded messages older than an hour are marked deleted: their SMS paths
    /// are stale, so deletion would never succeed.
    pub fn mark_old_uploaded_as_deleted(&self) -> Result<usize> {
        let conn = self.conn();

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueStats {
    pub pending: usize,
    pub dead_letter: usize,
    pub in_flight: usize,
    pub oldest_unacknowledged_age_seconds: Option<u64>,
}

#[cfg(test)]
mod tests;
