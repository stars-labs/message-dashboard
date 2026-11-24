import * as v from 'valibot';
import { CallHistoryRow, type LiveCall } from '../../shared/api/calls.js';
import { queryAll, queryFirst, type D1 } from '../lib/d1.js';

const HISTORY_COLUMNS = `id, direction, iccid, remote_number, outcome, end_reason,
         started_at, answered_at, ended_at, duration_seconds, requested_by, answered_by`;

const OpenRingRow = v.object({
  id: v.string(),
  started_at: v.string(),
  remote_number: v.nullable(v.string()),
});

export type OpenRingRow = v.InferOutput<typeof OpenRingRow>;

const SimRow = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  sim_index: v.number(),
});

export type SimRow = v.InferOutput<typeof SimRow>;

export async function closeStaleCalls(
  db: D1<'run'>,
  {
    now,
    startedBefore,
    ringStartedBefore,
  }: { now: string; startedBefore: string; ringStartedBefore: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE calls
        SET outcome = CASE WHEN answered_at IS NULL THEN 'missed' ELSE 'failed' END,
            end_reason = 'stale',
            ended_at = COALESCE(ended_at, ?)
      WHERE outcome = 'in_progress'
        AND (started_at < ? OR (answered_at IS NULL AND started_at < ?))`,
    )
    .bind(now, startedBefore, ringStartedBefore)
    .run();
}

export async function insertInboundRing(
  db: D1<'run'>,
  { id, iccid, from, now }: { id: string; iccid: string; from: string | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO calls (id, direction, iccid, remote_number, outcome, started_at)
       VALUES (?, 'inbound', ?, ?, 'in_progress', ?)`,
    )
    .bind(id, iccid, from, now)
    .run();
}

export function findOpenRing(db: D1<'first'>, iccid: string): Promise<OpenRingRow | null> {
  return queryFirst(
    db
      .prepare(
        `SELECT id, started_at, remote_number
         FROM calls
        WHERE iccid = ? AND direction = 'inbound' AND outcome = 'in_progress'
          AND answered_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      )
      .bind(iccid),
    OpenRingRow,
  );
}

export async function insertCall(db: D1<'run'>, call: LiveCall): Promise<void> {
  await db
    .prepare(
      `INSERT INTO calls (id, direction, iccid, remote_number, outcome, started_at, requested_by)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      call.id,
      call.direction,
      call.iccid,
      call.number,
      call.started_at,
      call.requested_by ?? null,
    )
    .run();
}

export async function setRemoteNumber(
  db: D1<'run'>,
  callId: string,
  number: string,
): Promise<void> {
  await db
    .prepare(`UPDATE calls SET remote_number = ? WHERE id = ? AND remote_number IS NULL`)
    .bind(number, callId)
    .run();
}

export async function markCallAnswered(
  db: D1<'run'>,
  callId: string,
  at: string,
  by: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE calls
        SET answered_at = COALESCE(answered_at, ?), answered_by = COALESCE(answered_by, ?)
      WHERE id = ? AND outcome = 'in_progress'`,
    )
    .bind(at, by, callId)
    .run();
}

export async function markCallEnded(
  db: D1<'run'>,
  {
    callId,
    endedAt,
    reason,
    unansweredOutcome,
  }: { callId: string; endedAt: string; reason: string; unansweredOutcome: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE calls
          SET ended_at = ?,
              end_reason = ?,
              duration_seconds = CASE
                WHEN answered_at IS NULL THEN 0
                ELSE MAX(0, CAST((julianday(?) - julianday(answered_at)) * 86400 AS INTEGER))
              END,
              outcome = CASE WHEN answered_at IS NULL THEN ? ELSE 'answered' END
        WHERE id = ? AND outcome = 'in_progress'`,
    )
    .bind(endedAt, reason, endedAt, unansweredOutcome, callId)
    .run();
}

export function listCallHistory(
  db: D1<'all'>,
  { iccid, limit, offset }: { iccid: string | undefined; limit: number; offset: number },
): Promise<CallHistoryRow[]> {
  const binds = iccid ? [iccid, limit, offset] : [limit, offset];
  return queryAll(
    db
      .prepare(
        `SELECT ${HISTORY_COLUMNS}
         FROM calls
        WHERE outcome != 'in_progress'${iccid ? ' AND iccid = ?' : ''}
        ORDER BY started_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      )
      .bind(...binds),
    CallHistoryRow,
  );
}

export function listSimsByIccid(db: D1<'all'>, iccids: string[]): Promise<SimRow[]> {
  const placeholders = iccids.map(() => '?').join(', ');
  return queryAll(
    db
      .prepare(
        `SELECT iccid, number, carrier, sim_index FROM device_view WHERE iccid IN (${placeholders})`,
      )
      .bind(...iccids),
    SimRow,
  );
}
