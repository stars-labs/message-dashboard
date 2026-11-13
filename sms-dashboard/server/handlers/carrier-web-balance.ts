import { nanoid } from 'nanoid';
import { senderMatches } from '../utils/spam-filter.js';
import {
  authorizeRunnerControl,
  runnerCanAccessOwner,
  RUNNER_SCOPES,
} from '../utils/runner-auth.js';
import type { RunnerAuth } from '../utils/runner-auth.js';
import type { AppRequest } from '../worker-context.js';
import type { D1Database, D1PreparedStatement } from '../cf-bindings.js';

/** The browser-driven balance providers. Keys are sim_balance_web_jobs.provider. */
type WebProvider = 'china_unicom' | 'm1_prepaid';

interface ProviderConfig {
  skillId: string;
  currency: string;
  otpContext: RegExp;
  rawResponse: string;
  expiryRequired: boolean;
}

/** A sim_balance_web_jobs row joined with its check, profile and SIM. */
interface WebJob {
  id: string;
  check_id: string;
  provider: string;
  status: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  human_reason: string | null;
  otp_requested_at: string | null;
  sim_iccid: string;
  check_status: string;
  profile_id: string;
  requested_by_subject: string | null;
  login_url: string | null;
  expected_senders: string | null;
  skill_config: string | null;
  profile_parser_version: string;
  sim_number: string | null;
  sim_index: number | null;
  [column: string]: unknown;
}

/** The runner-supplied body shared by the lease endpoints. */
interface WebJobBody {
  runner_id?: unknown;
  status?: unknown;
  reason?: unknown;
  balance?: unknown;
  currency?: unknown;
  account_number?: unknown;
  expires_at?: unknown;
  error?: unknown;
}

const NORMAL_LEASE_SECONDS = 120;
const HUMAN_LEASE_SECONDS = 900;
const ACTIVE_STATUSES = [
  'leased',
  'awaiting_otp',
  'authenticating',
  'querying',
  'human_verification_required',
];
const HEARTBEAT_STATUSES = new Set(ACTIVE_STATUSES);
const PROVIDERS: Record<WebProvider, ProviderConfig> = Object.freeze({
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
});

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function readJson(request: AppRequest): Promise<WebJobBody | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizePhone(value: unknown, provider: string): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (provider === 'china_unicom') return digits.replace(/^86(?=1\d{10}$)/, '');
  if (provider === 'm1_prepaid') return digits.replace(/^65(?=\d{8}$)/, '');
  return digits;
}

function validIsoDate(value: unknown): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function expectedSenderMatches(rawSender: unknown, expectedSendersJson: unknown): boolean {
  let expected: unknown;
  try {
    expected = JSON.parse(String(expectedSendersJson ?? ''));
  } catch {
    return false;
  }
  return Array.isArray(expected) && expected.some((sender) => senderMatches(rawSender, sender));
}

function leaseIsActive(job: WebJob | null, runnerId: string): boolean {
  if (!job || !ACTIVE_STATUSES.includes(job.status) || job.lease_owner !== runnerId) return false;
  return new Date(`${job.lease_expires_at}Z`) > new Date();
}

async function loadJob(db: D1Database, id: string | undefined): Promise<WebJob | null> {
  return db
    .prepare(
      `
    SELECT
      j.*, c.sim_iccid, c.status AS check_status, c.profile_id,
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
    .bind(id)
    .first<WebJob>();
}

function eventStatement(
  db: D1Database,
  jobId: string,
  eventType: string,
  detail: Record<string, unknown> = {},
): D1PreparedStatement {
  return db
    .prepare(
      `
    INSERT INTO sim_balance_web_events (job_id, event_type, detail_json)
    VALUES (?, ?, ?)
  `,
    )
    .bind(jobId, eventType, JSON.stringify(detail));
}

export async function reconcileTerminalWebBalanceJobs(db: D1Database) {
  const results = await db.batch([
    db
      .prepare(
        `
      INSERT INTO sim_balance_web_events (job_id, event_type, detail_json)
      SELECT j.id, 'reconciled', json_object('web_job_status', j.status)
      FROM sim_balance_web_jobs j
      JOIN sim_balance_checks c ON c.id = j.check_id
      WHERE c.status = 'queued' AND j.status IN ('failed', 'stopped')
    `,
      )
      .bind(),
    db
      .prepare(
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
      )
      .bind(),
    db
      .prepare(
        `
      UPDATE sim_balance_web_jobs
      SET lease_owner = NULL, lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('failed', 'stopped')
        AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL)
    `,
      )
      .bind(),
  ]);

  return {
    reconciled: Number(
      (results?.[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0,
    ),
  };
}

export async function maintainWebBalanceJobs(db: D1Database) {
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
    expired: Number(
      (expired?.[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0,
    ),
    reconciled: terminal.reconciled,
  };
}

async function requireLease(
  request: AppRequest,
  body: WebJobBody | null,
  auth: RunnerAuth,
): Promise<
  | { job: WebJob; body: WebJobBody & { runner_id: string }; response?: undefined }
  | { response: Response; job?: undefined; body?: undefined }
> {
  if (!body || typeof body.runner_id !== 'string') {
    return { response: json({ error: 'runner_id is required' }, 400) };
  }
  const job = await loadJob(request.env.DB, request.params?.id);
  if (!job) return { response: json({ error: 'Web balance job not found' }, 404) };
  if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
    return { response: json({ error: 'Web balance job belongs to another account' }, 403) };
  }
  if (!leaseIsActive(job, body.runner_id)) {
    return {
      response: json({ error: 'Web balance job lease is not active for this runner' }, 409),
    };
  }
  if (job.check_status !== 'queued') {
    return { response: json({ error: 'Balance check is no longer queued' }, 409) };
  }
  return { job, body: body as WebJobBody & { runner_id: string } };
}

export const carrierWebBalanceHandler = {
  async claim(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.carrierBrowser);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const runnerId = new URL(request.url).searchParams.get('runner_id')?.trim();
    if (!runnerId || runnerId.length > 200) return json({ error: 'runner_id is required' }, 400);

    const leased = await request.env.DB.prepare(
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
      .bind(runnerId, NORMAL_LEASE_SECONDS, auth.authMode, auth.subject, auth.authMode)
      .first();

    if (!leased) return new Response(null, { status: 204 });
    const job = await loadJob(request.env.DB, (leased as { id: string }).id);
    let skill: { id?: unknown } | null;
    try {
      skill = JSON.parse(job!.skill_config || '{}');
    } catch {
      skill = null;
    }
    const provider = PROVIDERS[job!.provider as WebProvider];
    if (!job || !skill || !provider || skill.id !== provider.skillId) {
      await request.env.DB.batch([
        request.env.DB.prepare(
          `
          UPDATE sim_balance_web_jobs
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              last_error = 'Invalid web skill configuration', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND lease_owner = ?
        `,
        ).bind(job!.id, runnerId),
        request.env.DB.prepare(
          `
          UPDATE sim_balance_checks
          SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
              error = 'Invalid web skill configuration', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'queued'
        `,
        ).bind(job!.check_id),
      ]);
      return new Response(null, { status: 204 });
    }

    const claimed = job!;
    await eventStatement(request.env.DB, claimed.id, 'claimed', {
      attempts: claimed.attempts,
    }).run();
    return json({
      id: claimed.id,
      check_id: claimed.check_id,
      sim_iccid: claimed.sim_iccid,
      sim_number: claimed.sim_number,
      sim_index: claimed.sim_index,
      login_url: claimed.login_url,
      otp_requested_at: claimed.otp_requested_at,
      skill,
    });
  },

  async otpRequested(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.carrierBrowser);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = await readJson(request);
    const lease = await requireLease(request, body, auth);
    if (lease.response) return lease.response;
    const { job, body: leased } = lease;
    if (job.otp_requested_at) return json({ error: 'OTP was already requested for this job' }, 409);

    await request.env.DB.batch([
      request.env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'awaiting_otp', otp_requested_at = CURRENT_TIMESTAMP,
            lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ? AND status = 'leased'
      `,
      ).bind(NORMAL_LEASE_SECONDS, job.id, leased.runner_id),
      eventStatement(request.env.DB, job.id, 'otp_requested'),
    ]);
    return json({ success: true, status: 'awaiting_otp' });
  },

  async otp(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.carrierBrowser);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const runnerId = new URL(request.url).searchParams.get('runner_id')?.trim();
    const lease = await requireLease(request, { runner_id: runnerId }, auth);
    if (lease.response) return lease.response;
    const { job } = lease;
    if (!job.otp_requested_at) return json({ error: 'OTP has not been requested' }, 409);

    const url = new URL(request.url);
    const afterCreatedAt = url.searchParams.get('after_created_at')?.trim() || null;
    const afterSourceMessageId = url.searchParams.get('after_source_message_id')?.trim() || null;
    const hasCursor = Boolean(
      afterCreatedAt &&
      afterSourceMessageId &&
      afterCreatedAt.length <= 40 &&
      afterSourceMessageId.length <= 200,
    );
    const cursorPredicate = hasCursor ? 'AND (created_at > ? OR (created_at = ? AND id > ?))' : '';
    const statement = request.env.DB.prepare(`
      SELECT id, phone_number, content, verification_code, created_at
      FROM messages
      WHERE phone_iccid = ? AND type = 'received'
        AND verification_code IS NOT NULL
        AND created_at >= ?
        ${cursorPredicate}
      ORDER BY created_at, id
      LIMIT 20
    `);
    const result = await (
      hasCursor
        ? statement.bind(
            job.sim_iccid,
            job.otp_requested_at,
            afterCreatedAt,
            afterCreatedAt,
            afterSourceMessageId,
          )
        : statement.bind(job.sim_iccid, job.otp_requested_at)
    ).all();
    const provider = PROVIDERS[job.provider as WebProvider];
    const candidates = result.results as Array<{
      id: string;
      phone_number: string | null;
      content: string | null;
      verification_code: string;
      created_at: string;
    }>;
    const message =
      provider &&
      candidates.find(
        (candidate) =>
          expectedSenderMatches(candidate.phone_number, job.expected_senders) &&
          provider.otpContext.test(candidate.content || ''),
      );
    if (!message) {
      const last = candidates.at(-1);
      if (!last) return new Response(null, { status: 204 });
      return json({
        code: null,
        cursor: {
          created_at: last.created_at,
          source_message_id: last.id,
        },
      });
    }

    await request.env.DB.batch([
      request.env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET otp_message_id = ?, lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(message.id, NORMAL_LEASE_SECONDS, job.id, runnerId),
      eventStatement(request.env.DB, job.id, 'otp_matched', { message_id: message.id }),
    ]);
    return json({ code: message.verification_code });
  },

  async heartbeat(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.carrierBrowser);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = await readJson(request);
    const lease = await requireLease(request, body, auth);
    if (lease.response) return lease.response;
    const { job, body: leased } = lease;
    if (!HEARTBEAT_STATUSES.has(String(leased.status)))
      return json({ error: 'Invalid web job status' }, 400);

    const human = leased.status === 'human_verification_required';
    const leaseSeconds = human ? HUMAN_LEASE_SECONDS : NORMAL_LEASE_SECONDS;
    const reason = human
      ? String(leased.reason || 'Official site requested human verification').slice(0, 500)
      : null;
    const statements = [
      request.env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = ?, human_reason = ?,
            lease_expires_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(leased.status, reason, leaseSeconds, job.id, leased.runner_id),
    ];
    if (job.status !== leased.status || job.human_reason !== reason) {
      statements.push(
        eventStatement(request.env.DB, job.id, String(leased.status), {
          status: leased.status,
          ...(reason ? { reason } : {}),
        }),
      );
    }
    await request.env.DB.batch(statements);
    return json({ success: true, status: leased.status, lease_seconds: leaseSeconds });
  },

  async complete(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.carrierBrowser);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = await readJson(request);
    const lease = await requireLease(request, body, auth);
    if (lease.response) return lease.response;
    const { job, body: leased } = lease;
    const balance = typeof leased.balance === 'number' ? leased.balance : Number.NaN;
    if (!Number.isFinite(balance) || balance < -100000 || balance > 1000000) {
      return json({ error: 'balance is invalid' }, 400);
    }
    const provider = PROVIDERS[job.provider as WebProvider];
    if (!provider) return json({ error: 'Unsupported browser balance provider' }, 400);
    if (leased.currency !== provider.currency) {
      return json({ error: `currency must be ${provider.currency}` }, 400);
    }
    const account = normalizePhone(
      typeof leased.account_number === 'string' ? leased.account_number : '',
      job.provider,
    );
    if (account === '' || account !== normalizePhone(job.sim_number, job.provider)) {
      return json({ error: 'Authenticated account does not match the balance task SIM' }, 409);
    }

    const expiresAt = provider.expiryRequired
      ? typeof leased.expires_at === 'string'
        ? leased.expires_at
        : ''
      : null;
    if (provider.expiryRequired && !validIsoDate(expiresAt)) {
      return json({ error: 'expires_at must be a real ISO calendar date' }, 400);
    }

    const statements = [
      request.env.DB.prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'parsed', completed_at = CURRENT_TIMESTAMP,
            raw_response = ?,
            error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
      ).bind(provider.rawResponse, job.check_id),
      request.env.DB.prepare(
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
        request.env.DB.prepare(
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
      request.env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            human_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(job.id, leased.runner_id),
      eventStatement(request.env.DB, job.id, 'completed', {
        currency: provider.currency,
        parser_version: job.profile_parser_version,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      }),
    );
    const results = await request.env.DB.batch(statements);
    if (
      Number((results?.[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 1) ===
      0
    ) {
      return json({ error: 'Balance check changed before completion' }, 409);
    }
    return json({ success: true, status: 'parsed' });
  },

  async fail(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.carrierBrowser);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = await readJson(request);
    const lease = await requireLease(request, body, auth);
    if (lease.response) return lease.response;
    const { job, body: leased } = lease;
    const error = String(leased.error || 'Web balance query failed').slice(0, 1000);
    await request.env.DB.batch([
      request.env.DB.prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
            error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
      ).bind(error, job.check_id),
      request.env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(error, job.id, leased.runner_id),
      eventStatement(request.env.DB, job.id, 'failed', { error }),
    ]);
    return json({ success: true, status: 'failed' });
  },

  async release(request: AppRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.carrierBrowser);
    if (!auth.authorized) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const body = await readJson(request);
    const lease = await requireLease(request, body, auth);
    if (lease.response) return lease.response;
    const { job, body: leased } = lease;
    const error = String(leased.error || 'Runner released the job').slice(0, 1000);
    const terminal = Boolean(job.otp_requested_at);
    const statements = [
      request.env.DB.prepare(
        `
        UPDATE sim_balance_web_jobs
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_owner = ?
      `,
      ).bind(terminal ? 'failed' : 'pending', error, job.id, leased.runner_id),
      eventStatement(request.env.DB, job.id, terminal ? 'failed_after_otp' : 'released', { error }),
    ];
    if (terminal) {
      statements.push(
        request.env.DB.prepare(
          `
        UPDATE sim_balance_checks
        SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
            error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
      `,
        ).bind(error, job.check_id),
      );
    }
    await request.env.DB.batch(statements);
    return json({ success: true, status: terminal ? 'failed' : 'pending' });
  },
};

function providerForProfile(
  profile: { skill_config?: string | null } | null | undefined,
): WebProvider {
  let skill: { id?: unknown } | null;
  try {
    skill = JSON.parse(profile?.skill_config || '{}');
  } catch {
    skill = null;
  }
  const entry = (Object.entries(PROVIDERS) as Array<[WebProvider, ProviderConfig]>).find(
    ([, config]) => config.skillId === skill?.id,
  );
  if (!entry) throw new Error('Unsupported browser balance profile');
  return entry[0];
}

export function createCarrierWebBalanceStatements(
  db: D1Database,
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
): D1PreparedStatement[] {
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
