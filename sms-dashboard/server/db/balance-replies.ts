import * as v from 'valibot';
import { queryAll, type D1, type D1Batch, type D1Statement } from '../lib/d1.js';
import { CHECK_STATUSES, type CheckStatus } from '../../shared/balance-status.js';
import type { BalanceMetric } from '../../shared/api/balance-checks.js';
import { changed } from './balance-checks.js';
import { Flag } from './balance-plan.js';

const PendingCheckRow = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  parser_version: v.string(),
  step_index: v.number(),
  status: v.picklist(CHECK_STATUSES),
  expected_senders: v.string(),
  conversation_steps: v.string(),
  skill_config: v.string(),
  destination: v.nullable(v.string()),
  sim_number: v.nullable(v.string()),
  response_window_open: Flag,
});

export type BalanceCheckRow = v.InferOutput<typeof PendingCheckRow>;

export interface BalanceMessage {
  id: string;
  phone_number: string | null;
  content: string;
}

export interface FollowUpCheck {
  id: string;
  sim_number: string | null;
  destination: string | null;
  step_index: number;
}

export function listPendingChecksForReply(
  db: D1<'all'>,
  { phone_iccid, message_timestamp }: { phone_iccid: string; message_timestamp: string },
): Promise<BalanceCheckRow[]> {
  return queryAll(
    db
      .prepare(
        `
    SELECT
      c.id,
      c.sim_iccid,
      c.profile_id,
      c.parser_version,
      c.step_index,
      c.status,
      p.expected_senders,
      p.conversation_steps,
      p.skill_config,
      p.destination,
      dv.number AS sim_number,
      datetime('now') <= datetime(c.deadline_at)
        AS response_window_open
    FROM sim_balance_checks c
    JOIN sim_balance_profiles p ON p.id = c.profile_id
    LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
    WHERE c.sim_iccid = ?
      AND c.status IN ('queued', 'awaiting_response', 'failed', 'timed_out')
      AND datetime(?) >= datetime(COALESCE((
        SELECT MAX(m.timestamp)
        FROM messages m
        WHERE m.balance_check_id = c.id AND m.type = 'sent'
      ), c.sent_at, c.requested_at))
      AND datetime(?) <= datetime(c.deadline_at)
    ORDER BY c.requested_at DESC
  `,
      )
      .bind(phone_iccid, message_timestamp, message_timestamp),
    PendingCheckRow,
  );
}

export async function recordBalanceReply(
  db: D1<'run'> & D1Batch<'run'>,
  {
    check,
    message,
    content,
    metrics,
    skillJobId,
  }: {
    check: Pick<BalanceCheckRow, 'id'>;
    message: BalanceMessage;
    content: string;
    metrics: readonly BalanceMetric[];
    skillJobId: string | null;
  },
): Promise<boolean> {
  const statements: D1Statement<'run'>[] = [
    db
      .prepare(
        `
    UPDATE sim_balance_checks
    SET status = ?,
        completed_at = CURRENT_TIMESTAMP,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status IN ('queued', 'awaiting_response', 'failed', 'timed_out')
  `,
      )
      .bind(
        metrics.length ? 'parsed' : 'response_received',
        message.id,
        message.phone_number,
        content,
        check.id,
      ),
  ];

  for (const metric of metrics) {
    statements.push(
      db
        .prepare(
          `
      INSERT INTO sim_balance_metrics (
        check_id, metric_type, value, unit, currency, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(check_id, metric_type) DO UPDATE SET
        value = excluded.value,
        unit = excluded.unit,
        currency = excluded.currency,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `,
        )
        .bind(
          check.id,
          metric.metric_type,
          metric.value,
          metric.unit,
          metric.currency,
          metric.expires_at,
        ),
    );
  }

  if (skillJobId !== null) {
    statements.push(
      db
        .prepare(
          `
      INSERT OR IGNORE INTO sim_balance_skill_jobs (
        id, check_id, response_message_id, step_index
      )
      SELECT ?, id, ?, step_index
      FROM sim_balance_checks
      WHERE id = ?
        AND status = 'response_received'
        AND response_message_id = ?
    `,
        )
        .bind(skillJobId, message.id, check.id, message.id),
    );
  }

  statements.push(
    db
      .prepare(
        `
    UPDATE messages
    SET purpose = 'balance_maintenance',
        balance_check_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND (balance_check_id IS NULL OR balance_check_id = ?)
      AND EXISTS (
        SELECT 1
        FROM sim_balance_checks c
        WHERE c.id = ?
          AND c.response_message_id = messages.id
      )
  `,
      )
      .bind(check.id, message.id, check.id, check.id),
  );

  const [update] = await db.batch(statements);
  return changed(update);
}

export async function expireStaleBalanceChecks(
  db: D1<'run'> & D1Batch<'run'>,
): Promise<{ expired: number; stopped_jobs: number }> {
  const [checks, jobs] = await db.batch([
    db.prepare(
      `
      UPDATE sim_balance_checks
      SET status = 'timed_out',
          completed_at = CURRENT_TIMESTAMP,
          error = 'No reply received within the configured response window',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'awaiting_response'
        AND deadline_at < CURRENT_TIMESTAMP
    `,
    ),
    db.prepare(
      `
      UPDATE sim_balance_skill_jobs
      SET status = 'stopped',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Balance response window expired'),
          updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'leased')
        AND EXISTS (
          SELECT 1
          FROM sim_balance_checks c
          WHERE c.id = sim_balance_skill_jobs.check_id
            AND c.status = 'timed_out'
        )
    `,
    ),
  ]);

  return {
    expired: checks?.meta.changes ?? 0,
    stopped_jobs: jobs?.meta.changes ?? 0,
  };
}

export async function queueBalanceFollowUpMessage(
  db: D1<'run'> & D1Batch<'run'>,
  {
    messageId,
    check,
    message,
    step,
    fromStatus,
    extraStatements,
  }: {
    messageId: string;
    check: FollowUpCheck;
    message: BalanceMessage;
    step: { command: string };
    fromStatus: CheckStatus;
    extraStatements: readonly D1Statement<'run'>[];
  },
): Promise<boolean> {
  const [insert] = await db.batch([
    db
      .prepare(
        `
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, timestamp, type, recipient,
        status, filter_status, purpose, balance_check_id
      )
      SELECT ?, c.sim_iccid, ?, ?, CURRENT_TIMESTAMP, 'sent', ?,
        'sending', 'filtered', 'balance_maintenance', c.id
      FROM sim_balance_checks c
      WHERE c.id = ? AND c.status = ? AND c.step_index = ?
    `,
      )
      .bind(
        messageId,
        check.sim_number,
        step.command,
        check.destination,
        check.id,
        fromStatus,
        check.step_index,
      ),
    db
      .prepare(
        `
    UPDATE sim_balance_checks
    SET status = 'queued',
        step_index = step_index + 1,
        completed_at = NULL,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        deadline_at = NULL,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = ?
      AND step_index = ?
    `,
      )
      .bind(
        message.id,
        message.phone_number,
        message.content,
        check.id,
        fromStatus,
        check.step_index,
      ),
    ...extraStatements,
  ]);
  return changed(insert);
}

export async function markBalanceCheckSmsResult(
  db: D1<'run'>,
  messageId: string,
  { submitted, failure }: { submitted: boolean; failure: string },
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE sim_balance_checks
    SET status = ?,
        sent_at = CASE WHEN ? THEN COALESCE(sent_at, CURRENT_TIMESTAMP) ELSE sent_at END,
        deadline_at = CASE WHEN ? THEN datetime(
          CURRENT_TIMESTAMP,
          '+' || (SELECT p.response_window_minutes
                  FROM sim_balance_profiles p
                  WHERE p.id = sim_balance_checks.profile_id) || ' minutes'
        ) ELSE deadline_at END,
        completed_at = CASE WHEN ? THEN completed_at ELSE CURRENT_TIMESTAMP END,
        error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT balance_check_id FROM messages WHERE id = ?
    )
      AND status = 'queued'
  `,
    )
    .bind(
      submitted ? 'awaiting_response' : 'failed',
      submitted ? 1 : 0,
      submitted ? 1 : 0,
      submitted ? 1 : 0,
      submitted ? null : failure,
      messageId,
    )
    .run();
}
