import * as v from 'valibot';
import { D1_MAX_BOUND_PARAMETERS, queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';

const CANCELLED_ERROR = 'Cancelled with its batch';

/**
 * A queued check nobody has started: its SMS is still waiting for the daemon, or its
 * browser job for a runner. `check` names the sim_balance_checks row.
 */
function notStarted(check: string): string {
  return `${check}.status = 'queued' AND (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = ${check}.outbound_message_id AND m.type = 'sent' AND m.status = 'sending'
    )
    OR EXISTS (
      SELECT 1 FROM sim_balance_web_jobs j
      WHERE j.check_id = ${check}.id AND j.status = 'pending'
    )
  )`;
}

const BatchRow = v.object({
  id: v.string(),
  requested_by_subject: v.nullable(v.string()),
  created_at: v.string(),
  cancelled_at: v.nullable(v.string()),
  total: v.number(),
  parsed: v.number(),
  failed: v.number(),
  cancelled: v.number(),
  cancellable: v.number(),
});

export type BatchRow = v.InferOutput<typeof BatchRow>;

const BATCH_SELECT = `
  SELECT b.id, b.requested_by_subject, b.created_at, b.cancelled_at,
    COUNT(c.id) AS total,
    COALESCE(SUM(c.status = 'parsed'), 0) AS parsed,
    COALESCE(SUM(c.status IN ('failed', 'timed_out', 'unparsed')), 0) AS failed,
    COALESCE(SUM(c.status = 'cancelled'), 0) AS cancelled,
    COALESCE(SUM(${notStarted('c')}), 0) AS cancellable
  FROM sim_balance_batches b
  LEFT JOIN sim_balance_checks c ON c.batch_id = b.id`;

export async function createBalanceBatch(
  db: D1<'run'>,
  id: string,
  requestedBySubject: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO sim_balance_batches (id, requested_by_subject) VALUES (?, ?)')
    .bind(id, requestedBySubject)
    .run();
}

/** Ties checks already queued to their batch; a list longer than one statement binds runs in chunks. */
export async function assignChecksToBatch(
  db: D1<'run'>,
  batchId: string,
  checkIds: readonly string[],
): Promise<void> {
  const chunkSize = D1_MAX_BOUND_PARAMETERS - 1;
  for (let start = 0; start < checkIds.length; start += chunkSize) {
    const chunk = checkIds.slice(start, start + chunkSize);
    await db
      .prepare(
        `UPDATE sim_balance_checks SET batch_id = ?
         WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .bind(batchId, ...chunk)
      .run();
  }
}

export function findBalanceBatch(db: D1<'first'>, id: string): Promise<BatchRow | null> {
  return queryFirst(db.prepare(`${BATCH_SELECT} WHERE b.id = ? GROUP BY b.id`).bind(id), BatchRow);
}

export function listRecentBalanceBatches(db: D1<'all'>, limit: number): Promise<BatchRow[]> {
  return queryAll(
    db
      .prepare(
        `${BATCH_SELECT}
         WHERE b.created_at >= datetime('now', '-7 days')
         GROUP BY b.id
         ORDER BY datetime(b.created_at) DESC, b.id DESC
         LIMIT ?`,
      )
      .bind(limit),
    BatchRow,
  );
}

/**
 * Cancels the batch's checks nobody has started, with their SMS and browser jobs, in
 * one transaction so the daemon or a runner cannot take one in between. Returns how
 * many checks this call cancelled.
 */
export async function cancelBalanceBatch(
  db: D1Batch<'run'> & D1<'run'>,
  id: string,
  cancelledBy: string,
): Promise<number> {
  const cancelledChecks = `SELECT id FROM sim_balance_checks WHERE batch_id = ? AND status = 'cancelled'`;
  const [, checks] = await db.batch([
    db
      .prepare(
        `UPDATE sim_balance_batches
         SET cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
             cancelled_by = COALESCE(cancelled_by, ?)
         WHERE id = ?`,
      )
      .bind(cancelledBy, id),
    db
      .prepare(
        `UPDATE sim_balance_checks
         SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, error = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE batch_id = ? AND ${notStarted('sim_balance_checks')}`,
      )
      .bind(CANCELLED_ERROR, id),
    db
      .prepare(
        `UPDATE messages SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE type = 'sent' AND status = 'sending'
           AND balance_check_id IN (${cancelledChecks})`,
      )
      .bind(id),
    db
      .prepare(
        `UPDATE sim_balance_web_jobs
         SET status = 'stopped', last_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE status = 'pending' AND check_id IN (${cancelledChecks})`,
      )
      .bind(CANCELLED_ERROR, id),
  ]);
  return checks?.meta.changes ?? 0;
}
