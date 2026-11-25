use super::{MessageStore, Segment, StoredSegment};
use crate::identifiers::{Iccid, SmsAddress};
use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use tracing::{debug, warn};

impl MessageStore {
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

        // Look before writing: an orphan part stays on the SIM and is re-read on
        // every scan, and rewriting it each time wears out the SD card.
        // It must be a separate SELECT, not an upsert with a filtering WHERE: this
        // table is AUTOINCREMENT, and SQLite allocates the rowid and rewrites
        // sqlite_sequence before it discovers the conflict.
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
