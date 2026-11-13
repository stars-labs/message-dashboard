import { queueBalanceFollowUp } from './balance-queries.js';
import {
  extractBalanceMenuOptions,
  parseBalanceSkillConfig,
  validateBalanceSkillDecision,
} from '../utils/balance-skill.js';
import type { BalanceDecision, BalanceSkill } from '../utils/balance-skill.js';
import {
  authorizeRunnerControl,
  runnerCanAccessOwner,
  RUNNER_SCOPES,
} from '../utils/runner-auth.js';
import type { AppRequest } from '../worker-context.js';
import type { D1Database, D1PreparedStatement } from '../cf-bindings.js';

const LEASE_SECONDS = 120;

/**
 * The job row loadJob selects, and the last argument of queueBalanceFollowUp.
 * `check_id` is the balance check's id because the caller rebuilds the object as
 * `{ ...job, id: job.check_id }`.
 */
interface SkillJob {
  id: string;
  check_id: string;
  response_message_id: string;
  step_index: number;
  status: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  check_status: string;
  sim_iccid: string | null;
  response_sender: string | null;
  requested_by_subject: string | null;
  destination: string | null;
  skill_config: unknown;
  sim_number: string | null;
  response_content: string;
}

/** Body of POST /api/control/balance-skills/jobs/:id/decision and .../release. */
interface DecisionBody {
  runner_id?: unknown;
  decision?: unknown;
  model?: unknown;
  error?: unknown;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function readJson(request: AppRequest): Promise<Record<string, unknown> | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function loadJob(db: D1Database, id: string | undefined): Promise<SkillJob | null> {
  return db
    .prepare(
      `
    SELECT
      j.id, j.check_id, j.response_message_id, j.step_index,
      j.status, j.lease_owner, j.lease_expires_at, j.attempts,
      c.status AS check_status, c.sim_iccid, c.response_sender,
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
    .bind(id)
    .first<SkillJob>();
}

function decisionStatement(
  db: D1Database,
  job: SkillJob,
  skill: BalanceSkill,
  model: unknown,
  decision: BalanceDecision,
): D1PreparedStatement {
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
      String(model || 'unknown').slice(0, 200),
      decision.action,
      decision.selected_option,
      decision.confidence,
      decision.reason,
      decision.evidence,
      JSON.stringify(decision),
    );
}

export const balanceSkillRunnerHandler = {
  async claim(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.smsAi);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const runnerId = new URL(request.url).searchParams.get('runner_id')?.trim();
    if (!runnerId || runnerId.length > 200) {
      return json({ error: 'runner_id is required' }, 400);
    }

    const leased = await request.env.DB.prepare(
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
      .bind(runnerId, LEASE_SECONDS, auth.authMode, auth.subject, auth.authMode)
      .first<{ id: string }>();

    if (!leased) return new Response(null, { status: 204 });
    const job = await loadJob(request.env.DB, leased.id);
    const skill = parseBalanceSkillConfig(job?.skill_config);
    if (!job || !skill || Number(job.step_index) >= Number(skill.max_turns)) {
      await request.env.DB.prepare(
        `
        UPDATE sim_balance_skill_jobs
        SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      )
        .bind('Skill configuration is invalid or maximum turns reached', leased.id, runnerId)
        .run();
      return new Response(null, { status: 204 });
    }

    return json({
      id: job.id,
      check_id: job.check_id,
      step_index: job.step_index,
      attempts: job.attempts,
      skill,
      menu_options: extractBalanceMenuOptions(job.response_content),
      response_content: job.response_content,
    });
  },

  async decide(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.smsAi);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = (await readJson(request)) as DecisionBody | null;
    if (!body || typeof body.runner_id !== 'string' || !body.decision) {
      return json({ error: 'runner_id and decision are required' }, 400);
    }

    const db = request.env.DB;
    const job = await loadJob(db, request.params?.id);
    if (!job) return json({ error: 'Skill job not found' }, 404);
    if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
      return json({ error: 'Skill job belongs to another account' }, 403);
    }
    if (
      job.status !== 'leased' ||
      job.lease_owner !== body.runner_id ||
      new Date(`${job.lease_expires_at}Z`) <= new Date()
    ) {
      return json({ error: 'Skill job lease is not active for this runner' }, 409);
    }
    if (!['response_received', 'unparsed'].includes(job.check_status)) {
      return json({ error: 'Balance check is no longer awaiting a skill decision' }, 409);
    }

    const skill = parseBalanceSkillConfig(job.skill_config);
    if (!skill) return json({ error: 'Balance skill configuration is invalid' }, 409);

    let decision: BalanceDecision;
    try {
      decision = validateBalanceSkillDecision({
        decision: body.decision,
        content: job.response_content,
        skill,
      });
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }

    const audit = decisionStatement(db, job, skill, body.model, decision);
    if (decision.action === 'reply') {
      const finishJob = db
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
        .bind(job.id, body.runner_id, Number(job.step_index) + 1);
      const result = await queueBalanceFollowUp(
        db,
        {
          ...job,
          id: job.check_id,
        } as unknown as Parameters<typeof queueBalanceFollowUp>[1],
        {
          id: job.response_message_id,
          phone_number: job.response_sender,
          content: job.response_content,
        },
        { command: decision.selected_option ?? '' },
        job.check_status,
        [audit, finishJob],
      );
      if (!result.queued) {
        return json({ error: 'Balance check changed before the decision was applied' }, 409);
      }
      return json({ success: true, action: 'reply', status: 'queued' }, 202);
    }

    if (decision.action === 'complete') {
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
        .bind(job.id, body.runner_id, job.step_index);
      const results = await db.batch<{ meta?: { changes?: number } }>([
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
      if (Number(results?.[0]?.meta?.changes ?? 1) === 0) {
        return json({ error: 'Balance check changed before the decision was applied' }, 409);
      }
      return json({ success: true, action: 'complete', status: 'parsed' });
    }

    const finishJob = db
      .prepare(
        `
      UPDATE sim_balance_skill_jobs
      SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `,
      )
      .bind(job.id, body.runner_id);
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
    return json({ success: true, action: 'stop', reason: decision.reason });
  },

  async release(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.smsAi);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = (await readJson(request)) as DecisionBody | null;
    if (!body || typeof body.runner_id !== 'string') {
      return json({ error: 'runner_id is required' }, 400);
    }
    const job = await loadJob(request.env.DB, request.params?.id);
    if (!job) return json({ error: 'Skill job not found' }, 404);
    if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
      return json({ error: 'Skill job belongs to another account' }, 403);
    }
    const result = await request.env.DB.prepare(
      `
      UPDATE sim_balance_skill_jobs
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `,
    )
      .bind(
        String(body.error || 'Runner released the job').slice(0, 1000),
        request.params?.id,
        body.runner_id,
      )
      .run();
    if (Number(result?.meta?.changes || 0) === 0) {
      return json({ error: 'Skill job lease is not active for this runner' }, 409);
    }
    return json({ success: true });
  },
};
