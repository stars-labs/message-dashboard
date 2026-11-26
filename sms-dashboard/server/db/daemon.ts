import * as v from 'valibot';
import { queryAll, queryFirst, type D1 } from '../lib/d1.js';

const IdRow = v.object({ id: v.string() });

const PendingMessageRow = v.object({
  id: v.string(),
  phone_iccid: v.string(),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  recipient: v.pipe(v.string(), v.brand('SmsAddress')),
  purpose: v.picklist(['user', 'balance_maintenance']),
  created_at: v.string(),
});

/** julianday() of an unreadable last_heartbeat is NULL, so the age can be null. */
const DaemonHealthRow = v.object({
  daemon_id: v.string(),
  last_heartbeat: v.string(),
  metadata: v.nullable(v.string()),
  seconds_since_heartbeat: v.nullable(v.number()),
});

interface ReceivedMessageInsert {
  id: string;
  phone_iccid: string;
  phone_number: string | null;
  content: string;
  timestamp: string;
  verification_code: string | null;
  filter_status: string;
  filter_rule_id: unknown;
  purpose: string;
  balance_check_id: string | null;
}

export async function insertReceivedMessage(
  db: D1<'run'>,
  message: ReceivedMessageInsert,
): Promise<number> {
  const result = await db
    .prepare(
      `
        INSERT INTO messages (
          id, phone_iccid, phone_number, content, timestamp, type,
          verification_code, status, created_at, updated_at,
          filter_status, filter_rule_id, purpose, balance_check_id
        )
        VALUES (
          ?, ?, ?, ?, ?, 'received', ?, 'received',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?
        ) ON CONFLICT(id) DO NOTHING
      `,
    )
    .bind(
      message.id,
      message.phone_iccid,
      message.phone_number,
      message.content,
      message.timestamp,
      message.verification_code,
      message.filter_status,
      message.filter_rule_id,
      message.purpose,
      message.balance_check_id,
    )
    .run();
  return result.meta.changes;
}

export async function markStaleProcessingMessagesUnknown(
  db: D1<'run'>,
  daemonSessionId: string,
): Promise<void> {
  await db
    .prepare(
      `
          UPDATE messages INDEXED BY idx_messages_processing_outbound
          SET status = 'unknown',
              error_message = 'Daemon restarted before confirming SMS delivery; delivery status is unknown',
              processing_session_id = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE type = 'sent'
            AND status = 'processing'
            AND (
              (processing_session_id IS NOT NULL AND processing_session_id <> ?)
              OR (
                processing_session_id IS NULL
                AND datetime(updated_at) <= datetime('now', '-5 minutes')
              )
            )
        `,
    )
    .bind(daemonSessionId)
    .run();
}

export async function listSendingMessageIds(db: D1<'all'>): Promise<string[]> {
  const rows = await queryAll(
    db.prepare(
      `
        SELECT id
        FROM (
          SELECT
            id,
            purpose,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY purpose ORDER BY created_at, id) AS purpose_rank
          FROM messages INDEXED BY idx_messages_pending_outbound
          WHERE type = 'sent' AND status = 'sending'
        ) pending
        WHERE purpose != 'balance_maintenance' OR purpose_rank <= 5
        ORDER BY CASE WHEN purpose = 'balance_maintenance' THEN 1 ELSE 0 END,
                 created_at,
                 id
        LIMIT 50
      `,
    ),
    IdRow,
  );
  return rows.map((row) => row.id);
}

export async function markMessagesProcessing(
  db: D1<'run'>,
  daemonSessionId: string | null,
  ids: string[],
): Promise<void> {
  const placeholders = ids.map(() => '?').join(',');
  await db
    .prepare(
      `
        UPDATE messages
        SET status = 'processing',
            processing_session_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `,
    )
    .bind(daemonSessionId, ...ids)
    .run();
}

export function listMessagesByIds(db: D1<'all'>, ids: string[]) {
  const placeholders = ids.map(() => '?').join(',');
  return queryAll(
    db
      .prepare(
        `
        SELECT id, phone_iccid, phone_number, content, recipient, purpose, created_at
        FROM messages
        WHERE id IN (${placeholders})
        ORDER BY created_at ASC
      `,
      )
      .bind(...ids),
    PendingMessageRow,
  );
}

export async function updateSmsResult(
  db: D1<'run'>,
  messageId: string,
  status: string,
  errorMessage: string | null,
  smsId: string | null,
): Promise<number> {
  const result = await db
    .prepare(
      `
        UPDATE messages
        SET status = ?, error_message = ?, sms_id = ?,
            processing_session_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .bind(status, errorMessage, smsId, messageId)
    .run();
  return result.meta.changes;
}

export async function upsertDaemonHeartbeat(
  db: D1<'run'>,
  heartbeat: { clientIp: string; version: string; metadata: string; sessionId: string },
): Promise<void> {
  await db
    .prepare(
      `
        INSERT INTO daemon_health (
          daemon_id, last_heartbeat, status, last_ip, version,
          error_count, metadata, current_session_id, updated_at
        ) VALUES (
          'orange-pi-main', CURRENT_TIMESTAMP, 'online', ?, ?,
          0, ?, ?, CURRENT_TIMESTAMP
        )
        ON CONFLICT(daemon_id) DO UPDATE SET
          last_heartbeat = CURRENT_TIMESTAMP,
          status = 'online',
          last_ip = excluded.last_ip,
          version = excluded.version,
          error_count = excluded.error_count,
          metadata = excluded.metadata,
          current_session_id = excluded.current_session_id,
          updated_at = CURRENT_TIMESTAMP
    `,
    )
    .bind(heartbeat.clientIp, heartbeat.version, heartbeat.metadata, heartbeat.sessionId)
    .run();
}

export function getDaemonHealth(db: D1<'first'>) {
  return queryFirst(
    db.prepare(`
  SELECT daemon_id, last_heartbeat, metadata,
    CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) AS seconds_since_heartbeat
  FROM daemon_health
  WHERE daemon_id = 'orange-pi-main'
`),
    DaemonHealthRow,
  );
}
