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

#[derive(Debug)]
pub struct StoredMessage {
    pub id: i64,
    pub message: Message,
    pub modem_id: String,
    pub sms_path: String,
    pub status: MessageStatus,
    pub attempts: u32,
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                uploaded_at TIMESTAMP,
                deleted_at TIMESTAMP,
                error TEXT,
                UNIQUE(phone_iccid, timestamp, content)
            )",
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
             (phone_iccid, phone_number, content, timestamp, direction, modem_id, sms_path, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')",
            params![
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

    /// ROBUST CLEANUP: Delete ALL old pending messages that can't be uploaded
    pub fn cleanup_all_old_pending(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();

        // Delete ALL pending messages older than 1 hour
        // These have stale SMS paths and can't be uploaded anyway
        let deleted = conn.execute(
            "DELETE FROM messages
             WHERE status = 'pending'
               AND created_at < datetime('now', '-1 hour')",
            [],
        )?;

        if deleted > 0 {
            info!(
                "🔥 PURGED {} old pending messages that can't be uploaded",
                deleted
            );
        }

        // Also reset the sim_storage counts since we're cleaning up
        conn.execute(
            "UPDATE sim_storage
             SET total_messages = 0, deleted_messages = 0",
            [],
        )?;

        info!("✅ Reset all SIM storage counts");

        Ok(deleted)
    }

    /// Emergency cleanup - delete EVERYTHING pending
    pub fn emergency_cleanup(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();

        // Delete ALL pending messages regardless of age
        let deleted = conn.execute("DELETE FROM messages WHERE status = 'pending'", [])?;

        if deleted > 0 {
            warn!("⚠️ EMERGENCY CLEANUP: Deleted {} pending messages", deleted);
        }

        // Reset all counters
        conn.execute(
            "UPDATE sim_storage SET total_messages = 0, deleted_messages = 0",
            [],
        )?;

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

#[derive(Debug)]
pub struct MessageStats {
    pub pending: usize,
    pub uploading: usize,
    pub uploaded: usize,
    pub failed: usize,
    pub total: usize,
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
}
