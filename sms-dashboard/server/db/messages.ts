import * as v from 'valibot';
import { queryAll, queryFirst, type D1, type D1Batch, type D1RunResult } from '../lib/d1.js';

const MESSAGE_COLUMN_NAMES = [
  'id',
  'phone_iccid',
  'phone_number',
  'content',
  'timestamp',
  'type',
  'status',
  'recipient',
  'verification_code',
  'created_at',
  'updated_at',
  'error_message',
  'sms_id',
  'filter_status',
  'filter_rule_id',
  'purpose',
  'balance_check_id',
  'processing_session_id',
];

const MESSAGE_COLUMNS_OF_M = MESSAGE_COLUMN_NAMES.map((name) => `m.${name}`).join(', ');

const MessageRow = v.object({
  id: v.string(),
  phone_iccid: v.nullable(v.string()),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  timestamp: v.nullable(v.string()),
  type: v.nullable(v.string()),
  status: v.nullable(v.string()),
  recipient: v.nullable(v.string()),
  verification_code: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
  error_message: v.nullable(v.string()),
  sms_id: v.nullable(v.string()),
  filter_status: v.string(),
  filter_rule_id: v.nullable(v.number()),
  purpose: v.string(),
  balance_check_id: v.nullable(v.string()),
  processing_session_id: v.nullable(v.string()),
});

export type MessageRow = v.InferOutput<typeof MessageRow>;

const DeviceSummary = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  sim_status: v.string(),
  sim_index: v.number(),
  country: v.nullable(v.string()),
});

export type DeviceSummary = v.InferOutput<typeof DeviceSummary>;

const CountRow = v.object({ n: v.number() });
const IdRow = v.object({ id: v.string() });

// Timestamps are stored as ISO-8601 with T and Z; datetime() returns a space-separated,
// Z-less string that compares wrongly against them.
const CUTOFF_EXPR = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)`;

export function listMessages(
  db: D1<'all'>,
  { conditions, params, orderBy }: { conditions: string[]; params: unknown[]; orderBy: string },
): Promise<MessageRow[]> {
  const listWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
        SELECT ${MESSAGE_COLUMNS_OF_M}
        FROM messages m
        ${listWhere}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `;
  return queryAll(db.prepare(sql).bind(...params), MessageRow);
}

// Scoped to `sent` rows and ordered by the indexed `updated_at` (migration 079), so it
// cannot scan message history.
export function listOutboundStatusChanges(
  db: D1<'all'>,
  {
    since,
    until,
    phoneIccid,
    limit,
  }: {
    since: string;
    until: string;
    phoneIccid: string | null;
    limit: number;
  },
): Promise<MessageRow[]> {
  const conditions = [
    `m.purpose = 'user'`,
    `m.type = 'sent'`,
    `m.updated_at IS NOT NULL`,
    `m.updated_at >= datetime(?, '-2 seconds')`,
    `m.updated_at <= datetime(?)`,
  ];
  const params: unknown[] = [since, until];
  if (phoneIccid) {
    conditions.push(`m.phone_iccid = ?`);
    params.push(phoneIccid);
  }
  params.push(limit);

  return queryAll(
    db
      .prepare(
        `
    SELECT ${MESSAGE_COLUMNS_OF_M}
    FROM messages m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.updated_at DESC
    LIMIT ?
  `,
      )
      .bind(...params),
    MessageRow,
  );
}

export function listDeviceSummaries(db: D1<'all'>, iccids: string[]): Promise<DeviceSummary[]> {
  const placeholders = iccids.map(() => '?').join(', ');
  return queryAll(
    db
      .prepare(
        `
      SELECT iccid, number, carrier, sim_status, sim_index, country
      FROM device_view
      WHERE iccid IN (${placeholders})
    `,
      )
      .bind(...iccids),
    DeviceSummary,
  );
}

export function findActiveDeviceNumber(
  db: D1<'first'>,
  iccid: string,
): Promise<{ number: string } | null> {
  return queryFirst(
    db
      .prepare(
        `
        SELECT number FROM device_view WHERE iccid = ? AND sim_status = 'active'
      `,
      )
      .bind(iccid),
    v.object({ number: v.string() }),
  );
}

export function findDeviceStatus(
  db: D1<'first'>,
  iccid: string,
): Promise<{ iccid: string; sim_status: string } | null> {
  return queryFirst(
    db
      .prepare(
        `
          SELECT iccid, sim_status FROM device_view WHERE iccid = ?
        `,
      )
      .bind(iccid),
    v.object({ iccid: v.string(), sim_status: v.string() }),
  );
}

export function insertSentMessage(
  db: D1<'run'>,
  message: {
    id: string;
    phoneIccid: string;
    phoneNumber: string;
    content: string;
    timestamp: string;
    recipient: string;
  },
): Promise<D1RunResult> {
  return db
    .prepare(
      `
        INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, recipient, status)
        VALUES (?, ?, ?, ?, ?, 'sent', ?, 'sending')
      `,
    )
    .bind(
      message.id,
      message.phoneIccid,
      message.phoneNumber,
      message.content,
      message.timestamp,
      message.recipient,
    )
    .run();
}

export async function countExpiredMessages(db: D1<'first'>, modifier: string): Promise<number> {
  const row = await queryFirst(
    db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE timestamp < ${CUTOFF_EXPR}`)
      .bind(modifier),
    CountRow,
  );
  return row?.n ?? 0;
}

export async function listExpiredMessageIds(
  db: D1<'all'>,
  modifier: string,
  limit: number,
): Promise<string[]> {
  const rows = await queryAll(
    db
      .prepare(
        `SELECT id FROM messages WHERE timestamp < ${CUTOFF_EXPR} ORDER BY timestamp LIMIT ?`,
      )
      .bind(modifier, limit),
    IdRow,
  );
  return rows.map((row) => row.id);
}

export async function deleteMessagesAndTags(
  db: D1<'all' | 'first'> & D1Batch<'all' | 'first'>,
  ids: string[],
): Promise<void> {
  const placeholders = ids.map(() => '?').join(', ');
  await db.batch([
    db.prepare(`DELETE FROM message_tags WHERE message_id IN (${placeholders})`).bind(...ids),
    db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...ids),
  ]);
}

export async function countMessagesByFilterStatus(
  db: D1<'first'>,
  filterStatus: string,
): Promise<number> {
  const row = await queryFirst(
    db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE filter_status = ?`).bind(filterStatus),
    CountRow,
  );
  return row?.n ?? 0;
}

const FilterCandidateRow = v.object({
  id: v.string(),
  type: v.nullable(v.string()),
  content: v.string(),
  phone_number: v.nullable(v.string()),
});

type FilterCandidateRow = v.InferOutput<typeof FilterCandidateRow>;

export function listMessagesByFilterStatus(
  db: D1<'all'>,
  filterStatus: string,
  limit: number,
): Promise<FilterCandidateRow[]> {
  return queryAll(
    db
      .prepare(
        `SELECT id, type, content, phone_number
         FROM messages
         WHERE filter_status = ?
         ORDER BY rowid
         LIMIT ?`,
      )
      .bind(filterStatus, limit),
    FilterCandidateRow,
  );
}

export async function updateMessageFilterVerdicts(
  db: D1<'run'> & D1Batch<'run'>,
  verdicts: { id: string; filterStatus: string; filterRuleId: number | null }[],
): Promise<void> {
  const update = db.prepare(
    `UPDATE messages SET filter_status = ?, filter_rule_id = ? WHERE id = ?`,
  );
  await db.batch(
    verdicts.map((verdict) => update.bind(verdict.filterStatus, verdict.filterRuleId, verdict.id)),
  );
}

const ScanRow = v.object({
  row_cursor: v.number(),
  id: v.string(),
  content: v.string(),
  verification_code: v.nullable(v.string()),
});

type ScanRow = v.InferOutput<typeof ScanRow>;

export function listReceivedMessagesAfter(
  db: D1<'all'>,
  cursor: number,
  limit: number,
): Promise<ScanRow[]> {
  return queryAll(
    db
      .prepare(
        `SELECT rowid AS row_cursor, id, content, verification_code
       FROM messages
       WHERE rowid > ? AND type = 'received'
       ORDER BY rowid
       LIMIT ?`,
      )
      .bind(cursor, limit),
    ScanRow,
  );
}

export async function updateVerificationCodes(
  db: D1<'run'> & D1Batch<'run'>,
  changes: { id: string; code: string | null }[],
  pendingStatus: string,
): Promise<void> {
  const update = db.prepare(
    `UPDATE messages
       SET verification_code = ?, filter_status = ?, filter_rule_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
  );
  await db.batch(changes.map((change) => update.bind(change.code, pendingStatus, change.id)));
}
