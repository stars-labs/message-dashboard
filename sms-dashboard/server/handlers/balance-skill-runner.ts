import { json } from '../lib/response.js';
import * as v from 'valibot';
import type { Parsed } from '../../shared/parse-json.js';
import { queryFirst, type D1, type D1Batch, type D1Statement } from '../lib/d1.js';
import { NOT_JSON_MESSAGE, readBody, type MissingKeyMessages } from '../lib/request-body.js';
import { textOr } from '../../shared/text.js';
import {
  extractBalanceMenuOptions,
  parseBalanceSkillConfig,
  validateBalanceSkillDecision,
  type BalanceDecision,
  type BalanceSkill,
} from '../utils/balance-skill.js';
import { CHECK_STATUSES, SKILL_JOB_STATUSES } from '../utils/balance-status.js';
import { errorText } from '../utils/d1-error.js';
import {
  authorizeRunnerControl,
  runnerCanAccessOwner,
  RUNNER_SCOPES,
  type RunnerRequest,
} from '../utils/runner-auth.js';
import { queueBalanceFollowUp } from './balance-queries.js';

const LEASE_SECONDS = 120;

const RUNNER_ID_REQUIRED = 'runner_id is required';
const DECISION_REQUIRED = 'runner_id and decision are required';
const MODEL_NOT_TEXT = 'model must be text';
const ERROR_NOT_TEXT = 'error must be text';
const LEASE_NOT_ACTIVE = 'Skill job lease is not active for this runner';
const DECISION_RACED = 'Balance check changed before the decision was applied';

/**
 * A skill job with its check, profile, SIM number and the reply it answers. The
 * reply is an inner join, so its id and content are never null here.
 */
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

type SkillJob = v.InferOutput<typeof SkillJobRow>;

const LeasedRow = v.object({ id: v.string() });

/** Any value but an absent or falsy one; the decision's shape is the validator's to judge. */
const DecideBody = v.object(
  {
    runner_id: v.string(DECISION_REQUIRED),
    decision: v.pipe(
      v.unknown(),
      v.check((decision) => Boolean(decision), DECISION_REQUIRED),
    ),
    model: v.nullish(v.string(MODEL_NOT_TEXT)),
  },
  DECISION_REQUIRED,
);

const DECIDE_MISSING_KEY_MESSAGES = {
  runner_id: DECISION_REQUIRED,
} as const satisfies MissingKeyMessages<typeof DecideBody>;

const ReleaseBody = v.object(
  {
    runner_id: v.string(RUNNER_ID_REQUIRED),
    error: v.nullish(v.string(ERROR_NOT_TEXT)),
  },
  RUNNER_ID_REQUIRED,
);

const RELEASE_MISSING_KEY_MESSAGES = {
  runner_id: RUNNER_ID_REQUIRED,
} as const satisfies MissingKeyMessages<typeof ReleaseBody>;

interface ClaimRequest extends RunnerRequest {
  url: string;
  env: RunnerRequest['env'] & { DB: D1<'first' | 'run'> };
}

interface JobRequest extends RunnerRequest {
  params?: Record<string, string>;
  env: RunnerRequest['env'] & { DB: D1<'first' | 'run'> & D1Batch<'run'> };
  text(): Promise<string>;
}

/** readBody, answering a body that is not JSON with the route's missing-field message. */
async function readRunnerBody<S extends v.GenericSchema>(
  request: { text(): Promise<string> },
  schema: S,
  missingKeyMessages: MissingKeyMessages<S>,
  notJsonMessage: string,
): Promise<Parsed<v.InferOutput<S>>> {
  const body = await readBody(request, schema, missingKeyMessages);
  return body.ok || body.error !== NOT_JSON_MESSAGE ? body : { ok: false, error: notJsonMessage };
}

function loadJob(db: D1<'first'>, id: string): Promise<SkillJob | null> {
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

function leaseIsActive(job: SkillJob, runnerId: string): boolean {
  return (
    job.status === 'leased' &&
    job.lease_owner === runnerId &&
    job.lease_expires_at !== null &&
    new Date(`${job.lease_expires_at}Z`) > new Date()
  );
}

function decisionStatement(
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

export const balanceSkillRunnerHandler = {
  async claim(request: ClaimRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.smsAi);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const runnerId = new URL(request.url).searchParams.get('runner_id')?.trim();
    if (!runnerId || runnerId.length > 200) {
      return json({ error: RUNNER_ID_REQUIRED }, 400);
    }

    const leased = await queryFirst(
      request.env.DB.prepare(
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
      ).bind(runnerId, LEASE_SECONDS, auth.authMode, auth.subject, auth.authMode),
      LeasedRow,
    );

    if (!leased) return new Response(null, { status: 204 });
    const job = await loadJob(request.env.DB, leased.id);
    const skill = job ? parseBalanceSkillConfig(job.skill_config) : null;
    if (!job || !skill || job.step_index >= skill.max_turns) {
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

  async decide(request: JobRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.smsAi);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = await readRunnerBody(
      request,
      DecideBody,
      DECIDE_MISSING_KEY_MESSAGES,
      DECISION_REQUIRED,
    );
    if (!body.ok) return json({ error: body.error }, 400);
    const { runner_id: runnerId, model } = body.value;

    const db = request.env.DB;
    const job = await loadJob(db, request.params?.['id'] ?? '');
    if (!job) return json({ error: 'Skill job not found' }, 404);
    if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
      return json({ error: 'Skill job belongs to another account' }, 403);
    }
    if (!leaseIsActive(job, runnerId)) {
      return json({ error: LEASE_NOT_ACTIVE }, 409);
    }
    if (job.check_status !== 'response_received' && job.check_status !== 'unparsed') {
      return json({ error: 'Balance check is no longer awaiting a skill decision' }, 409);
    }

    const skill = parseBalanceSkillConfig(job.skill_config);
    if (!skill) return json({ error: 'Balance skill configuration is invalid' }, 409);

    let decision: BalanceDecision;
    try {
      decision = validateBalanceSkillDecision({
        decision: body.value.decision,
        content: job.response_content,
        skill,
      });
    } catch (error) {
      return json({ error: errorText(error) }, 400);
    }

    const audit = decisionStatement(db, job, skill, model, decision);
    switch (decision.action) {
      case 'reply': {
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
          .bind(job.id, runnerId, job.step_index + 1);
        const result = await queueBalanceFollowUp(
          db,
          {
            id: job.check_id,
            sim_number: job.sim_number,
            destination: job.destination,
            step_index: job.step_index,
          },
          {
            id: job.response_message_id,
            phone_number: job.response_sender,
            content: job.response_content,
          },
          { command: decision.selected_option ?? '' },
          job.check_status,
          [audit, finishJob],
        );
        if (!result.queued) return json({ error: DECISION_RACED }, 409);
        return json({ success: true, action: 'reply', status: 'queued' }, 202);
      }

      case 'complete': {
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
        if (parsed?.meta.changes === 0) return json({ error: DECISION_RACED }, 409);
        return json({ success: true, action: 'complete', status: 'parsed' });
      }

      case 'stop': {
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
        return json({ success: true, action: 'stop', reason: decision.reason });
      }
    }
  },

  async release(request: JobRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.smsAi);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = await readRunnerBody(
      request,
      ReleaseBody,
      RELEASE_MISSING_KEY_MESSAGES,
      RUNNER_ID_REQUIRED,
    );
    if (!body.ok) return json({ error: body.error }, 400);

    const id = request.params?.['id'] ?? '';
    const job = await loadJob(request.env.DB, id);
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
        textOr(body.value.error, 'Runner released the job').slice(0, 1000),
        id,
        body.value.runner_id,
      )
      .run();
    if (result.meta.changes === 0) {
      return json({ error: LEASE_NOT_ACTIVE }, 409);
    }
    return json({ success: true });
  },
};
