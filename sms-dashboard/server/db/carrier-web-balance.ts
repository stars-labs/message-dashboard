import * as v from 'valibot';
import { queryAll, queryFirst, type D1, type D1Batch, type D1Statement } from '../lib/d1.js';
import {
  CHECK_STATUSES,
  WEB_JOB_STATUSES,
  type ActiveWebJobStatus,
} from '../../shared/balance-status.js';
import type { AuthorizedRunner } from '../utils/runner-auth.js';

export const WEB_PROVIDERS = ['china_unicom', 'm1_prepaid'] as const;

export type WebProvider = (typeof WEB_PROVIDERS)[number];
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

type WebEventDetail = Readonly<Record<string, string | number>>;

const LeasedRow = v.object({ id: v.string() });

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

export type WebJob = v.InferOutput<typeof WebJobRow>;

// created_at and verification_code are nullable columns; the query's predicates exclude both nulls.
const OtpCandidateRow = v.object({
  id: v.string(),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  verification_code: v.string(),
  created_at: v.string(),
});

type OtpCandidate = v.InferOutput<typeof OtpCandidateRow>;

export async function loadWebJob(db: D1<'first'>, id: string): Promise<WebJob | null> {
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

function webEventStatement(
  db: D1<'run'>,
  jobId: string,
  eventType: WebEventType,
  detail: WebEventDetail = {},
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

export async function recordWebEvent(
  db: D1<'run'>,
  jobId: string,
  eventType: WebEventType,
  detail: WebEventDetail = {},
): Promise<void> {
  await webEventStatement(db, jobId, eventType, detail).run();
}

export async function reconcileTerminalWebJobs(db: D1<'run'> & D1Batch<'run'>): Promise<number> {
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
      WHERE status = 'queued' AND EXISTS (
        SELECT 1 FROM sim_balance_web_jobs j
        WHERE j.check_id = sim_balance_checks.id AND j.status IN ('failed', 'stopped')
      )
    `,
    ),
  ]);

  return results[1]?.meta.changes ?? 0;
}

export async function failExpiredWebJobs(
  db: D1<'run'> & D1Batch<'run'>,
  reason: string,
): Promise<number> {
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
      .bind(reason),
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
      .bind(reason),
  ]);
  return expired[0]?.meta.changes ?? 0;
}

export function claimWebJob(
  db: D1<'first'>,
  runnerId: string,
  leaseSeconds: number,
  auth: AuthorizedRunner,
): Promise<{ id: string } | null> {
  return queryFirst(
    db
      .prepare(
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
      )
      .bind(runnerId, leaseSeconds, auth.authMode, auth.subject, auth.authMode),
    LeasedRow,
  );
}

export async function failLeasedWebJob(
  db: D1<'run'> & D1Batch<'run'>,
  jobId: string,
  checkId: string,
  runnerId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `
          UPDATE sim_balance_web_jobs
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              last_error = 'Invalid web skill configuration', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND lease_owner = ?
        `,
      )
      .bind(jobId, runnerId),
    db
      .prepare(
        `
          UPDATE sim_balance_checks
          SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
              error = 'Invalid web skill configuration', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'queued'
        `,
      )
      .bind(checkId),
  ]);
}

export async function markWebJobAwaitingOtp(
  db: D1<'run'> & D1Batch<'run'>,
  jobId: string,
  runnerId: string,
  leaseSeconds: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'awaiting_otp', otp_requested_at = CURRENT_TIMESTAMP,
            lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ? AND status = 'leased'
      `,
      )
      .bind(leaseSeconds, jobId, runnerId),
    webEventStatement(db, jobId, 'otp_requested'),
  ]);
}

export function listOtpCandidates(
  db: D1<'all'>,
  simIccid: string,
  otpRequestedAt: string,
  cursor: { createdAt: string; messageId: string } | null,
): Promise<OtpCandidate[]> {
  const cursorPredicate =
    cursor === null ? '' : 'AND (created_at > ? OR (created_at = ? AND id > ?))';
  const statement = db.prepare(`
      SELECT id, phone_number, content, verification_code, created_at
      FROM messages
      WHERE phone_iccid = ? AND type = 'received'
        AND verification_code IS NOT NULL
        AND created_at >= ?
        ${cursorPredicate}
      ORDER BY created_at, id
      LIMIT 20
    `);
  return queryAll(
    cursor === null
      ? statement.bind(simIccid, otpRequestedAt)
      : statement.bind(
          simIccid,
          otpRequestedAt,
          cursor.createdAt,
          cursor.createdAt,
          cursor.messageId,
        ),
    OtpCandidateRow,
  );
}

export async function recordWebOtpMatch(
  db: D1<'run'> & D1Batch<'run'>,
  jobId: string,
  runnerId: string,
  messageId: string,
  leaseSeconds: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `
        UPDATE sim_balance_web_jobs
        SET otp_message_id = ?, lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      )
      .bind(messageId, leaseSeconds, jobId, runnerId),
    webEventStatement(db, jobId, 'otp_matched', { message_id: messageId }),
  ]);
}

export async function recordWebHeartbeat(
  db: D1<'run'> & D1Batch<'run'>,
  jobId: string,
  runnerId: string,
  status: ActiveWebJobStatus,
  reason: string | null,
  leaseSeconds: number,
  event: WebEventDetail | null,
): Promise<void> {
  const statements: D1Statement<'run'>[] = [
    db
      .prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = ?, human_reason = ?,
            lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      )
      .bind(status, reason, leaseSeconds, jobId, runnerId),
  ];
  if (event !== null) statements.push(webEventStatement(db, jobId, status, event));
  await db.batch(statements);
}

export async function completeWebJob(
  db: D1<'run'> & D1Batch<'run'>,
  job: { id: string; check_id: string },
  runnerId: string,
  result: {
    balance: number;
    currency: string;
    rawResponse: string;
    expiresAt: string | null;
    expiryRequired: boolean;
    event: WebEventDetail;
  },
): Promise<number | undefined> {
  const statements: D1Statement<'run'>[] = [
    db
      .prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'parsed', completed_at = CURRENT_TIMESTAMP,
            raw_response = ?,
            error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
      )
      .bind(result.rawResponse, job.check_id),
    db
      .prepare(
        `
        INSERT INTO sim_balance_metrics (
          check_id, metric_type, value, unit, currency, expires_at
        ) SELECT id, 'cash_balance', ?, NULL, ?, NULL
          FROM sim_balance_checks WHERE id = ? AND status = 'parsed'
        ON CONFLICT(check_id, metric_type) DO UPDATE SET
          value = excluded.value, currency = excluded.currency,
          created_at = CURRENT_TIMESTAMP
      `,
      )
      .bind(result.balance, result.currency, job.check_id),
  ];
  if (result.expiryRequired) {
    statements.push(
      db
        .prepare(
          `
        INSERT INTO sim_balance_metrics (
          check_id, metric_type, value, unit, currency, expires_at
        ) SELECT id, 'account_expiry', NULL, NULL, NULL, ?
          FROM sim_balance_checks WHERE id = ? AND status = 'parsed'
        ON CONFLICT(check_id, metric_type) DO UPDATE SET
          expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP
      `,
        )
        .bind(result.expiresAt, job.check_id),
    );
  }
  statements.push(
    db
      .prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            human_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      )
      .bind(job.id, runnerId),
    webEventStatement(db, job.id, 'completed', result.event),
  );
  const results = await db.batch(statements);
  return results[0]?.meta.changes;
}

export async function failWebJob(
  db: D1<'run'> & D1Batch<'run'>,
  job: { id: string; check_id: string },
  runnerId: string,
  error: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
            error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
      )
      .bind(error, job.check_id),
    db
      .prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      )
      .bind(error, job.id, runnerId),
    webEventStatement(db, job.id, 'failed', { error }),
  ]);
}

export async function releaseWebJob(
  db: D1<'run'> & D1Batch<'run'>,
  job: { id: string; check_id: string },
  runnerId: string,
  error: string,
  terminal: boolean,
): Promise<void> {
  const statements: D1Statement<'run'>[] = [
    db
      .prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      )
      .bind(terminal ? 'failed' : 'pending', error, job.id, runnerId),
    webEventStatement(db, job.id, terminal ? 'failed_after_otp' : 'released', { error }),
  ];
  if (terminal) {
    statements.push(
      db
        .prepare(
          `
        UPDATE sim_balance_checks
        SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
            error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
        )
        .bind(error, job.check_id),
    );
  }
  await db.batch(statements);
}

export function queueWebBalanceStatements(
  db: D1<'run'>,
  {
    checkId,
    jobId,
    iccid,
    profile,
    provider,
    requestedBySubject,
  }: {
    checkId: string;
    jobId: string;
    iccid: string;
    profile: { id: string; parser_version: string };
    provider: WebProvider;
    requestedBySubject: string | null;
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
      .bind(checkId, iccid, profile.id, profile.parser_version, requestedBySubject),
    db
      .prepare(
        `
      INSERT INTO sim_balance_web_jobs (id, check_id, provider)
      VALUES (?, ?, ?)
    `,
      )
      .bind(jobId, checkId, provider),
    webEventStatement(db, jobId, 'queued'),
  ];
}
