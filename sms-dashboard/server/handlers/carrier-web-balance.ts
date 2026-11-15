import { ORPCError } from '@orpc/server';
import { nanoid } from 'nanoid';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import {
  queryAll,
  queryFirst,
  type D1,
  type D1Batch,
  type D1Operation,
  type D1Statement,
} from '../lib/d1.js';
import { textOr } from '../../shared/text.js';
import {
  WebJobCompleteFields,
  WebJobErrorFields,
  WebJobHeartbeatFields,
  type CarrierWebBalanceJobWire,
  type CarrierWebBalanceOtpWire,
  type WebJobActionResponse,
  type WebJobCompleteBody,
  type WebJobErrorBody,
  type WebJobHeartbeatBody,
  type WebJobHeartbeatResponse,
  type WebJobLeaseBody,
  type WebJobOtpQuery,
} from '../../shared/api/carrier-web-balance.js';
import { runnerCanAccessOwner, type AuthorizedRunner } from '../utils/runner-auth.js';
import { senderMatches } from '../utils/spam-filter.js';
import {
  ACTIVE_WEB_JOB_STATUSES,
  CHECK_STATUSES,
  WEB_JOB_STATUSES,
  type ActiveWebJobStatus,
} from '../../shared/balance-status.js';

const WEB_PROVIDERS = ['china_unicom', 'm1_prepaid'] as const;

type WebProvider = (typeof WEB_PROVIDERS)[number];
type WebEventType =
  | ActiveWebJobStatus
  | 'queued'
  | 'claimed'
  | 'otp_requested'
  | 'otp_matched'
  | 'completed'
  | 'failed'
  | 'failed_after_otp'
  | 'released';

interface ProviderConfig {
  skillId: string;
  currency: string;
  otpContext: RegExp;
  rawResponse: string;
  expiryRequired: boolean;
}

const NORMAL_LEASE_SECONDS = 120;
const HUMAN_LEASE_SECONDS = 900;
const PROVIDERS: Readonly<Record<WebProvider, ProviderConfig>> = {
  china_unicom: {
    skillId: 'unicom-web-balance',
    currency: 'CNY',
    otpContext: /(?:随机密码|隨機密碼|验证码|驗證碼|登录|登錄|登入)/,
    rawResponse: 'Official China Unicom web balance query',
    expiryRequired: false,
  },
  m1_prepaid: {
    skillId: 'm1-prepaid-web-balance',
    currency: 'SGD',
    otpContext: /\botp\s+for\s+login\b/i,
    rawResponse: 'Official M1 prepaid portal balance query',
    expiryRequired: true,
  },
};

const ActiveStatusSchema = v.picklist(ACTIVE_WEB_JOB_STATUSES);

const LeasedRow = v.object({ id: v.string() });

/** A sim_balance_web_jobs row joined with its check, profile and SIM. */
const WebJobRow = v.object({
  id: v.string(),
  check_id: v.string(),
  provider: v.picklist(WEB_PROVIDERS),
  status: v.picklist(WEB_JOB_STATUSES),
  lease_owner: v.nullable(v.string()),
  lease_expires_at: v.nullable(v.string()),
  attempts: v.number(),
  last_error: v.nullable(v.string()),
  human_reason: v.nullable(v.string()),
  otp_requested_at: v.nullable(v.string()),
  sim_iccid: v.string(),
  check_status: v.picklist(CHECK_STATUSES),
  profile_id: v.string(),
  requested_by_subject: v.nullable(v.string()),
  login_url: v.string(),
  expected_senders: v.string(),
  skill_config: v.string(),
  profile_parser_version: v.string(),
  sim_number: v.nullable(v.string()),
  sim_index: v.nullable(v.number()),
});

type WebJob = v.InferOutput<typeof WebJobRow>;

/** Messages.created_at and verification_code are nullable columns; the query's predicates exclude both nulls. */
const OtpCandidateRow = v.object({
  id: v.string(),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  verification_code: v.string(),
  created_at: v.string(),
});

const SkillConfig = v.looseObject({ id: v.string() });

const IsoDate = v.pipe(v.string(), v.check(validIsoDate));

/** A job route as the contract hands it over, once the runner has been admitted. */
interface JobCall<Op extends D1Operation = 'first'> {
  env: { DB: D1<Op | 'run'> & D1Batch<'run'> };
}

/** A refusal the Agent reads as { error }. */
function refused(
  code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
  message: string,
): ORPCError<string, undefined> {
  return new ORPCError(code, { message });
}

/** The rest of an action's body, read once the lease holds. */
function fieldsOf<S extends v.GenericSchema>(schema: S, body: unknown): v.InferOutput<S> {
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) throw refused('BAD_REQUEST', parsed.issues[0].message);
  return parsed.output;
}

function normalizePhone(value: string, provider: WebProvider): string {
  const digits = value.replace(/\D/g, '');
  switch (provider) {
    case 'china_unicom':
      return digits.replace(/^86(?=1\d{10}$)/, '');
    case 'm1_prepaid':
      return digits.replace(/^65(?=\d{8}$)/, '');
  }
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function expectedSenderMatches(rawSender: string | null, expectedSendersJson: string): boolean {
  const expected = parseJson(expectedSendersJson, v.array(v.unknown()));
  return expected.ok && expected.value.some((sender) => senderMatches(rawSender, sender));
}

function leaseIsActive(job: WebJob, runnerId: string): boolean {
  if (
    !v.is(ActiveStatusSchema, job.status) ||
    job.lease_owner !== runnerId ||
    job.lease_expires_at === null
  ) {
    return false;
  }
  return new Date(`${job.lease_expires_at}Z`) > new Date();
}

async function loadJob(db: D1<'first'>, id: string): Promise<WebJob | null> {
  return queryFirst(
    db
      .prepare(
        `
    SELECT
      j.id, j.check_id, j.provider, j.status, j.lease_owner, j.lease_expires_at,
      j.attempts, j.last_error, j.human_reason, j.otp_requested_at,
      c.sim_iccid, c.status AS check_status, c.profile_id,
      c.requested_by_subject,
      p.command AS login_url, p.expected_senders, p.skill_config,
      p.parser_version AS profile_parser_version,
      dv.number AS sim_number, dv.sim_index
    FROM sim_balance_web_jobs j
    JOIN sim_balance_checks c ON c.id = j.check_id
    JOIN sim_balance_profiles p ON p.id = c.profile_id
    LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
    WHERE j.id = ?
  `,
      )
      .bind(id),
    WebJobRow,
  );
}

function eventStatement(
  db: D1<'run'>,
  jobId: string,
  eventType: WebEventType,
  detail: Readonly<Record<string, string | number>> = {},
): D1Statement<'run'> {
  return db
    .prepare(
      `
    INSERT INTO sim_balance_web_events (job_id, event_type, detail_json)
    VALUES (?, ?, ?)
  `,
    )
    .bind(jobId, eventType, JSON.stringify(detail));
}

export async function reconcileTerminalWebBalanceJobs(db: D1<'run'> & D1Batch<'run'>) {
  const results = await db.batch([
    db.prepare(
      `
      INSERT INTO sim_balance_web_events (job_id, event_type, detail_json)
      SELECT j.id, 'reconciled', json_object('web_job_status', j.status)
      FROM sim_balance_web_jobs j
      JOIN sim_balance_checks c ON c.id = j.check_id
      WHERE c.status = 'queued' AND j.status IN ('failed', 'stopped')
    `,
    ),
    db.prepare(
      `
      UPDATE sim_balance_checks
      SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
          error = COALESCE((
            SELECT NULLIF(j.last_error, '')
            FROM sim_balance_web_jobs j
            WHERE j.check_id = sim_balance_checks.id
              AND j.status IN ('failed', 'stopped')
          ), 'Browser balance job ended before completion'),
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'queued' AND id IN (
        SELECT check_id FROM sim_balance_web_jobs
        WHERE status IN ('failed', 'stopped')
      )
    `,
    ),
    db.prepare(
      `
      UPDATE sim_balance_web_jobs
      SET lease_owner = NULL, lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('failed', 'stopped')
        AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL)
    `,
    ),
  ]);

  return { reconciled: results[1]?.meta.changes ?? 0 };
}

export async function maintainWebBalanceJobs(db: D1<'run'> & D1Batch<'run'>) {
  const expiredReason = 'Browser runner lease expired after login flow started';
  const expired = await db.batch([
    db
      .prepare(
        `
      UPDATE sim_balance_checks
      SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
          error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'queued' AND id IN (
        SELECT check_id FROM sim_balance_web_jobs
        WHERE status IN ('leased', 'awaiting_otp', 'authenticating', 'querying',
                         'human_verification_required')
          AND datetime(lease_expires_at) < datetime('now')
      )
    `,
      )
      .bind(expiredReason),
    db
      .prepare(
        `
      UPDATE sim_balance_web_jobs
      SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('leased', 'awaiting_otp', 'authenticating', 'querying',
                       'human_verification_required')
        AND datetime(lease_expires_at) < datetime('now')
    `,
      )
      .bind(expiredReason),
  ]);
  const terminal = await reconcileTerminalWebBalanceJobs(db);
  return {
    expired: expired[0]?.meta.changes ?? 0,
    reconciled: terminal.reconciled,
  };
}

/** The job `id`, when `runnerId` holds its lease for the admitted runner's account. */
async function requireLease(
  db: D1<'first'>,
  auth: AuthorizedRunner,
  id: string,
  runnerId: string,
): Promise<WebJob> {
  const job = await loadJob(db, id);
  if (job === null) throw refused('NOT_FOUND', 'Web balance job not found');
  if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
    throw refused('FORBIDDEN', 'Web balance job belongs to another account');
  }
  if (!leaseIsActive(job, runnerId)) {
    throw refused('CONFLICT', 'Web balance job lease is not active for this runner');
  }
  if (job.check_status !== 'queued') throw refused('CONFLICT', 'Balance check is no longer queued');
  return job;
}

export const carrierWebBalanceHandler = {
  /** The oldest job this runner's account may take, leased to it; null when none waits. */
  async claim(
    { env }: JobCall,
    auth: AuthorizedRunner,
    runnerId: string,
  ): Promise<CarrierWebBalanceJobWire | null> {
    const leased = await queryFirst(
      env.DB.prepare(
        `
      UPDATE sim_balance_web_jobs
      SET status = 'leased', lease_owner = ?,
          lease_expires_at = datetime('now', '+' || ? || ' seconds'),
          attempts = attempts + 1, last_error = NULL,
          human_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT j.id
        FROM sim_balance_web_jobs j INDEXED BY idx_balance_web_jobs_pending_claim
        JOIN sim_balance_checks c ON c.id = j.check_id
        WHERE j.status = 'pending'
          AND j.attempts < 3
          AND c.status = 'queued'
          AND ((? = 'auth0_device' AND c.requested_by_subject = ?)
            OR (? = 'legacy_api_key' AND c.requested_by_subject IS NULL))
        ORDER BY j.created_at, j.id
        LIMIT 1
      )
      RETURNING id
    `,
      ).bind(runnerId, NORMAL_LEASE_SECONDS, auth.authMode, auth.subject, auth.authMode),
      LeasedRow,
    );

    if (leased === null) return null;
    const job = await loadJob(env.DB, leased.id);
    if (job === null) throw new Error(`Leased web balance job ${leased.id} could not be loaded`);
    const skill = parseJson(job.skill_config, SkillConfig);
    if (!skill.ok || skill.value.id !== PROVIDERS[job.provider].skillId) {
      await env.DB.batch([
        env.DB.prepare(
          `
          UPDATE sim_balance_web_jobs
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              last_error = 'Invalid web skill configuration', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND lease_owner = ?
        `,
        ).bind(job.id, runnerId),
        env.DB.prepare(
          `
          UPDATE sim_balance_checks
          SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
              error = 'Invalid web skill configuration', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'queued'
        `,
        ).bind(job.check_id),
      ]);
      return null;
    }

    await eventStatement(env.DB, job.id, 'claimed', {
      attempts: job.attempts,
    }).run();
    return {
      id: job.id,
      check_id: job.check_id,
      sim_iccid: job.sim_iccid,
      sim_number: job.sim_number,
      sim_index: job.sim_index,
      login_url: job.login_url,
      otp_requested_at: job.otp_requested_at,
      skill: skill.value,
    };
  },

  async otpRequested(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    { runner_id: runnerId }: v.InferOutput<typeof WebJobLeaseBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, runnerId);
    if (job.otp_requested_at !== null) {
      throw refused('CONFLICT', 'OTP was already requested for this job');
    }

    await env.DB.batch([
      env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'awaiting_otp', otp_requested_at = CURRENT_TIMESTAMP,
            lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ? AND status = 'leased'
      `,
      ).bind(NORMAL_LEASE_SECONDS, job.id, runnerId),
      eventStatement(env.DB, job.id, 'otp_requested'),
    ]);
    return { success: true, status: 'awaiting_otp' };
  },

  /** The code the carrier sent since the OTP was requested; null when none has arrived. */
  async otp(
    { env }: JobCall<'first' | 'all'>,
    auth: AuthorizedRunner,
    id: string,
    {
      runner_id: runnerId,
      after_created_at: afterCreatedAt,
      after_source_message_id: afterSourceMessageId,
    }: v.InferOutput<typeof WebJobOtpQuery>,
  ): Promise<CarrierWebBalanceOtpWire | null> {
    const job = await requireLease(env.DB, auth, id, runnerId);
    if (job.otp_requested_at === null) throw refused('CONFLICT', 'OTP has not been requested');

    const hasCursor =
      afterCreatedAt !== '' &&
      afterSourceMessageId !== '' &&
      afterCreatedAt.length <= 40 &&
      afterSourceMessageId.length <= 200;
    const cursorPredicate = hasCursor ? 'AND (created_at > ? OR (created_at = ? AND id > ?))' : '';
    const statement = env.DB.prepare(`
      SELECT id, phone_number, content, verification_code, created_at
      FROM messages
      WHERE phone_iccid = ? AND type = 'received'
        AND verification_code IS NOT NULL
        AND created_at >= ?
        ${cursorPredicate}
      ORDER BY created_at, id
      LIMIT 20
    `);
    const candidates = await queryAll(
      hasCursor
        ? statement.bind(
            job.sim_iccid,
            job.otp_requested_at,
            afterCreatedAt,
            afterCreatedAt,
            afterSourceMessageId,
          )
        : statement.bind(job.sim_iccid, job.otp_requested_at),
      OtpCandidateRow,
    );
    const provider = PROVIDERS[job.provider];
    const message = candidates.find(
      (candidate) =>
        expectedSenderMatches(candidate.phone_number, job.expected_senders) &&
        provider.otpContext.test(candidate.content),
    );
    if (message === undefined) {
      const last = candidates.at(-1);
      if (last === undefined) return null;
      return {
        code: null,
        cursor: {
          created_at: last.created_at,
          source_message_id: last.id,
        },
      };
    }

    await env.DB.batch([
      env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET otp_message_id = ?, lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(message.id, NORMAL_LEASE_SECONDS, job.id, runnerId),
      eventStatement(env.DB, job.id, 'otp_matched', { message_id: message.id }),
    ]);
    return { code: message.verification_code };
  },

  async heartbeat(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobHeartbeatBody>,
  ): Promise<WebJobHeartbeatResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const { status, reason: reported } = fieldsOf(WebJobHeartbeatFields, body);

    const human = status === 'human_verification_required';
    const leaseSeconds = human ? HUMAN_LEASE_SECONDS : NORMAL_LEASE_SECONDS;
    const reason = human
      ? textOr(reported, 'Official site requested human verification').slice(0, 500)
      : null;
    const statements: D1Statement<'run'>[] = [
      env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = ?, human_reason = ?,
            lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(status, reason, leaseSeconds, job.id, runnerId),
    ];
    if (job.status !== status || job.human_reason !== reason) {
      statements.push(
        eventStatement(env.DB, job.id, status, {
          status,
          ...(reason === null || reason === '' ? {} : { reason }),
        }),
      );
    }
    await env.DB.batch(statements);
    return { success: true, status, lease_seconds: leaseSeconds };
  },

  async complete(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobCompleteBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const {
      balance,
      currency,
      account_number: accountNumber,
      expires_at: reportedExpiry,
    } = fieldsOf(WebJobCompleteFields, body);
    const provider = PROVIDERS[job.provider];
    if (currency !== provider.currency) {
      throw refused('BAD_REQUEST', `currency must be ${provider.currency}`);
    }
    const account = normalizePhone(accountNumber ?? '', job.provider);
    if (account === '' || account !== normalizePhone(job.sim_number ?? '', job.provider)) {
      throw refused('CONFLICT', 'Authenticated account does not match the balance task SIM');
    }

    let expiresAt: string | null = null;
    if (provider.expiryRequired) {
      const expiry = v.safeParse(IsoDate, reportedExpiry);
      if (!expiry.success) {
        throw refused('BAD_REQUEST', 'expires_at must be a real ISO calendar date');
      }
      expiresAt = expiry.output;
    }

    const statements: D1Statement<'run'>[] = [
      env.DB.prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'parsed', completed_at = CURRENT_TIMESTAMP,
            raw_response = ?,
            error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
      ).bind(provider.rawResponse, job.check_id),
      env.DB.prepare(
        `
        INSERT INTO sim_balance_metrics (
          check_id, metric_type, value, unit, currency, expires_at
        ) SELECT id, 'cash_balance', ?, NULL, ?, NULL
          FROM sim_balance_checks WHERE id = ? AND status = 'parsed'
        ON CONFLICT(check_id, metric_type) DO UPDATE SET
          value = excluded.value, currency = excluded.currency,
          created_at = CURRENT_TIMESTAMP
      `,
      ).bind(balance, provider.currency, job.check_id),
    ];
    if (provider.expiryRequired) {
      statements.push(
        env.DB.prepare(
          `
        INSERT INTO sim_balance_metrics (
          check_id, metric_type, value, unit, currency, expires_at
        ) SELECT id, 'account_expiry', NULL, NULL, NULL, ?
          FROM sim_balance_checks WHERE id = ? AND status = 'parsed'
        ON CONFLICT(check_id, metric_type) DO UPDATE SET
          expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP
      `,
        ).bind(expiresAt, job.check_id),
      );
    }
    statements.push(
      env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            human_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(job.id, runnerId),
      eventStatement(env.DB, job.id, 'completed', {
        currency: provider.currency,
        parser_version: job.profile_parser_version,
        ...(expiresAt === null || expiresAt === '' ? {} : { expires_at: expiresAt }),
      }),
    );
    const results = await env.DB.batch(statements);
    if (results[0]?.meta.changes === 0) {
      throw refused('CONFLICT', 'Balance check changed before completion');
    }
    return { success: true, status: 'parsed' };
  },

  async fail(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobErrorBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const error = textOr(fieldsOf(WebJobErrorFields, body).error, 'Web balance query failed').slice(
      0,
      1000,
    );
    await env.DB.batch([
      env.DB.prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
            error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
      ).bind(error, job.check_id),
      env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(error, job.id, runnerId),
      eventStatement(env.DB, job.id, 'failed', { error }),
    ]);
    return { success: true, status: 'failed' };
  },

  async release(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobErrorBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const error = textOr(fieldsOf(WebJobErrorFields, body).error, 'Runner released the job').slice(
      0,
      1000,
    );
    const terminal = job.otp_requested_at !== null;
    const statements: D1Statement<'run'>[] = [
      env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(terminal ? 'failed' : 'pending', error, job.id, runnerId),
      eventStatement(env.DB, job.id, terminal ? 'failed_after_otp' : 'released', { error }),
    ];
    if (terminal) {
      statements.push(
        env.DB.prepare(
          `
        UPDATE sim_balance_checks
        SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
            error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
        ).bind(error, job.check_id),
      );
    }
    await env.DB.batch(statements);
    return { success: true, status: terminal ? 'failed' : 'pending' };
  },
};

function providerForProfile(profile: { skill_config?: string | null }): WebProvider {
  const skill = parseJson(textOr(profile.skill_config, '{}'), SkillConfig);
  const provider = skill.ok
    ? WEB_PROVIDERS.find((candidate) => PROVIDERS[candidate].skillId === skill.value.id)
    : undefined;
  if (provider === undefined) throw new Error('Unsupported browser balance profile');
  return provider;
}

export function createCarrierWebBalanceStatements(
  db: D1<'run'>,
  {
    checkId,
    jobId,
    phone,
    profile,
    requestedBySubject = null,
  }: {
    checkId: string;
    jobId: string;
    phone: { iccid: string };
    profile: { id: string; parser_version: string; skill_config?: string | null };
    requestedBySubject?: string | null;
  },
): D1Statement<'run'>[] {
  return [
    db
      .prepare(
        `
      INSERT INTO sim_balance_checks (
        id, sim_iccid, profile_id, status, parser_version, requested_by_subject
      ) VALUES (?, ?, ?, 'queued', ?, ?)
    `,
      )
      .bind(checkId, phone.iccid, profile.id, profile.parser_version, requestedBySubject),
    db
      .prepare(
        `
      INSERT INTO sim_balance_web_jobs (id, check_id, provider)
      VALUES (?, ?, ?)
    `,
      )
      .bind(jobId, checkId, providerForProfile(profile)),
    eventStatement(db, jobId, 'queued'),
  ];
}

export function newCarrierWebBalanceIds() {
  return {
    checkId: `bal-${nanoid()}`,
    jobId: `webbal-${nanoid()}`,
  };
}
