import * as v from 'valibot';
import { queryFirst, type D1, type D1Batch, type D1Statement } from '../lib/d1.js';
import { textOr } from '../../shared/text.js';
import type { BalanceDecision, BalanceSkill } from '../../shared/balance-skill.js';
import { CHECK_STATUSES, SKILL_JOB_STATUSES } from '../../shared/balance-status.js';
import type { AuthorizedRunner } from '../utils/runner-auth.js';

// The reply is an inner join, so its id and content are never null.
const SkillJobRow = v.object({
  id: v.string(),
  check_id: v.string(),
  response_message_id: v.string(),
  step_index: v.number(),
  status: v.picklist(SKILL_JOB_STATUSES),
  lease_owner: v.nullable(v.string()),
  lease_expires_at: v.nullable(v.string()),
  attempts: v.number(),
  check_status: v.picklist(CHECK_STATUSES),
  response_sender: v.nullable(v.string()),
  requested_by_subject: v.nullable(v.string()),
  destination: v.nullable(v.string()),
  skill_config: v.string(),
  sim_number: v.nullable(v.string()),
  response_content: v.string(),
});

export type SkillJob = v.InferOutput<typeof SkillJobRow>;

const LeasedRow = v.object({ id: v.string() });

export function loadSkillJob(db: D1<'first'>, id: string): Promise<SkillJob | null> {
  return queryFirst(
    db
      .prepare(
        `
    SELECT
      j.id, j.check_id, j.response_message_id, j.step_index,
      j.status, j.lease_owner, j.lease_expires_at, j.attempts,
      c.status AS check_status, c.response_sender,
      c.requested_by_subject,
      p.destination, p.skill_config,
      dv.number AS sim_number,
      rm.content AS response_content
    FROM sim_balance_skill_jobs j
    JOIN sim_balance_checks c ON c.id = j.check_id
    JOIN sim_balance_profiles p ON p.id = c.profile_id
    LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
    JOIN messages rm ON rm.id = j.response_message_id
    WHERE j.id = ?
  `,
      )
      .bind(id),
    SkillJobRow,
  );
}

export function skillDecisionStatement(
  db: D1<'run'>,
  job: SkillJob,
  skill: BalanceSkill,
  model: string | null | undefined,
  decision: BalanceDecision,
): D1Statement<'run'> {
  return db
    .prepare(
      `
    INSERT INTO sim_balance_skill_decisions (
      check_id, response_message_id, step_index, skill_id, skill_version,
      model, action, selected_option, confidence, reason, evidence, decision_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(
      job.check_id,
      job.response_message_id,
      job.step_index,
      skill.id,
      skill.version,
      textOr(model, 'unknown').slice(0, 200),
      decision.action,
      decision.selected_option,
      decision.confidence,
      decision.reason,
      decision.evidence,
      JSON.stringify(decision),
    );
}

export function claimSkillJob(
  db: D1<'first'>,
  runnerId: string,
  leaseSeconds: number,
  auth: AuthorizedRunner,
): Promise<{ id: string } | null> {
  return queryFirst(
    db
      .prepare(
        `
      UPDATE sim_balance_skill_jobs
      SET status = 'leased',
          lease_owner = ?,
          lease_expires_at = datetime('now', '+' || ? || ' seconds'),
          attempts = attempts + 1,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT j.id
        FROM sim_balance_skill_jobs j
        JOIN sim_balance_checks c ON c.id = j.check_id
        WHERE (j.status = 'pending'
          OR (j.status = 'leased' AND datetime(j.lease_expires_at) < datetime('now')))
          AND c.status IN ('response_received', 'unparsed')
          AND ((? = 'auth0_device' AND c.requested_by_subject = ?)
            OR (? = 'legacy_api_key' AND c.requested_by_subject IS NULL))
        ORDER BY datetime(j.created_at), j.id
        LIMIT 1
      )
      RETURNING id
    `,
      )
      .bind(runnerId, leaseSeconds, auth.authMode, auth.subject, auth.authMode),
    LeasedRow,
  );
}

export async function stopLeasedSkillJob(
  db: D1<'run'>,
  id: string,
  runnerId: string,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `
        UPDATE sim_balance_skill_jobs
        SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
    )
    .bind(error, id, runnerId)
    .run();
}

export function completeSkillJobAfterReplyStatement(
  db: D1<'run'>,
  job: SkillJob,
  runnerId: string,
): D1Statement<'run'> {
  return db
    .prepare(
      `
        UPDATE sim_balance_skill_jobs
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'leased' AND lease_owner = ?
          AND EXISTS (
            SELECT 1 FROM sim_balance_checks c
            WHERE c.id = check_id AND c.status = 'queued' AND c.step_index = ?
          )
      `,
    )
    .bind(job.id, runnerId, job.step_index + 1);
}

export async function recordParsedSkillBalance(
  db: D1<'run'> & D1Batch<'run'>,
  job: SkillJob,
  runnerId: string,
  decision: BalanceDecision,
  audit: D1Statement<'run'>,
): Promise<number | undefined> {
  const finishJob = db
    .prepare(
      `
        UPDATE sim_balance_skill_jobs
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'leased' AND lease_owner = ?
          AND EXISTS (
            SELECT 1 FROM sim_balance_checks c
            WHERE c.id = check_id AND c.status = 'parsed' AND c.step_index = ?
          )
      `,
    )
    .bind(job.id, runnerId, job.step_index);
  const [parsed] = await db.batch([
    db
      .prepare(
        `
          UPDATE sim_balance_checks
          SET status = 'parsed', completed_at = CURRENT_TIMESTAMP,
              error = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = ? AND step_index = ?
        `,
      )
      .bind(job.check_id, job.check_status, job.step_index),
    db
      .prepare(
        `
          INSERT INTO sim_balance_metrics (
            check_id, metric_type, value, unit, currency, expires_at
          )
          SELECT id, 'cash_balance', ?, NULL, ?, NULL
          FROM sim_balance_checks
          WHERE id = ? AND status = 'parsed' AND step_index = ?
          ON CONFLICT(check_id, metric_type) DO UPDATE SET
            value = excluded.value, currency = excluded.currency,
            created_at = CURRENT_TIMESTAMP
        `,
      )
      .bind(decision.balance, decision.currency, job.check_id, job.step_index),
    audit,
    finishJob,
  ]);
  return parsed?.meta.changes;
}

export async function stopSkillJobWithDecision(
  db: D1<'run'> & D1Batch<'run'>,
  job: SkillJob,
  runnerId: string,
  audit: D1Statement<'run'>,
): Promise<void> {
  const finishJob = db
    .prepare(
      `
      UPDATE sim_balance_skill_jobs
      SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `,
    )
    .bind(job.id, runnerId);
  const finishCheck = db
    .prepare(
      `
      UPDATE sim_balance_checks
      SET status = 'unparsed', completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('response_received', 'unparsed')
        AND step_index = ?
    `,
    )
    .bind(job.check_id, job.step_index);
  await db.batch([audit, finishCheck, finishJob]);
}

export async function releaseSkillJob(
  db: D1<'run'>,
  id: string,
  runnerId: string,
  error: string,
): Promise<number> {
  const result = await db
    .prepare(
      `
      UPDATE sim_balance_skill_jobs
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `,
    )
    .bind(error, id, runnerId)
    .run();
  return result.meta.changes;
}
