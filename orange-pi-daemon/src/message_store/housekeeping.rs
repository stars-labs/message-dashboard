use super::{MessageStatus, MessageStore};
use crate::identifiers::Iccid;
use crate::types::Message;
use anyhow::Result;
use rusqlite::params;
use std::collections::HashMap;
use tracing::info;

impl MessageStore {
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

    /// Deletes empty-content messages that have failed 3 or more times.
    pub fn cleanup_empty_messages(&self) -> Result<usize> {
        let conn = self.conn();

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
