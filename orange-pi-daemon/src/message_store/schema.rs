use super::MessageStatus;
use anyhow::Result;
use rusqlite::{params, Connection};

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|name| name == column))
}

pub(super) fn configure_connection(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = 10000;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

pub(super) fn create_messages_table(conn: &Connection) -> Result<()> {
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

pub(super) fn upgrade_messages_table(conn: &Connection) -> Result<()> {
    // The server never assigns these IDs: each local row gets its identity here.
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

pub(super) fn recover_message_statuses(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE messages SET status = ?1 WHERE status = 'failed'",
        params![MessageStatus::Pending],
    )?;
    conn.execute(
        "UPDATE messages SET status = ?1 WHERE status = 'uploading'",
        params![MessageStatus::InFlight],
    )?;
    // Rows migrated from `uploading` have no lease expiry, so they would never
    // satisfy the in-flight recovery predicate in `claim_messages`.
    conn.execute(
        "UPDATE messages
         SET status = ?1, lease_token = NULL, lease_expires_at = NULL
         WHERE status = ?2 AND lease_expires_at IS NULL",
        params![MessageStatus::Pending, MessageStatus::InFlight],
    )?;
    Ok(())
}

pub(super) fn create_message_indexes(conn: &Connection) -> Result<()> {
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

pub(super) fn create_sim_storage_table(conn: &Connection) -> Result<()> {
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

pub(super) fn create_multipart_segments_table(conn: &Connection) -> Result<()> {
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

    // Segments buffered before the column existed came from EC20's MT view,
    // which is an alias for ME.
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

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_multipart_group
         ON multipart_segments(phone_iccid, sender, ref_id, total_parts)",
        [],
    )?;
    Ok(())
}
