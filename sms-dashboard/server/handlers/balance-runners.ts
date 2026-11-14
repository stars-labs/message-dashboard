import { json } from '../lib/response.js';
import * as v from 'valibot';
import { queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';
import { readBody, type MissingKeyMessages } from '../lib/request-body.js';
import { authorizeRunnerControl, RUNNER_SCOPES, type RunnerRequest } from '../utils/runner-auth.js';
import {
  BalanceRunner,
  BalanceRunnerCapability,
  RUNNER_CAPABILITIES,
  RUNNER_STATES,
  type BalanceRunnerCapabilitySummary,
  type BalanceRunnersResponse,
} from '../../shared/api/balance-runners.js';

const ONLINE_SECONDS = 90;

const AUTH_MODES = ['legacy_api_key', 'auth0_device'] as const;

type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

const INVALID_HEARTBEAT = 'Invalid runner heartbeat';

function boundedText(max: number) {
  return v.pipe(
    v.string(INVALID_HEARTBEAT),
    v.trim(),
    v.minLength(1, INVALID_HEARTBEAT),
    v.maxLength(max, INVALID_HEARTBEAT),
  );
}

const HeartbeatCapability = v.object(
  {
    capability: v.picklist(RUNNER_CAPABILITIES, INVALID_HEARTBEAT),
    state: v.picklist(RUNNER_STATES, INVALID_HEARTBEAT),
    current_job_id: v.nullish(boundedText(200), null),
    detail_code: v.nullish(boundedText(100), null),
    concurrency: v.optional(
      v.pipe(
        v.number(INVALID_HEARTBEAT),
        v.integer(INVALID_HEARTBEAT),
        v.minValue(1, INVALID_HEARTBEAT),
        v.maxValue(8, INVALID_HEARTBEAT),
      ),
      1,
    ),
  },
  INVALID_HEARTBEAT,
);

/** One heartbeat reports each capability at most once. */
const HeartbeatBody = v.object(
  {
    runner_id: boundedText(200),
    session_id: boundedText(200),
    display_name: boundedText(200),
    platform: boundedText(100),
    version: boundedText(100),
    capabilities: v.pipe(
      v.array(HeartbeatCapability, INVALID_HEARTBEAT),
      v.check(
        (items) => new Set(items.map((item) => item.capability)).size === items.length,
        INVALID_HEARTBEAT,
      ),
    ),
  },
  INVALID_HEARTBEAT,
);

const HEARTBEAT_MISSING_KEY_MESSAGES = {
  runner_id: INVALID_HEARTBEAT,
  session_id: INVALID_HEARTBEAT,
  display_name: INVALID_HEARTBEAT,
  platform: INVALID_HEARTBEAT,
  version: INVALID_HEARTBEAT,
  capabilities: INVALID_HEARTBEAT,
} as const satisfies MissingKeyMessages<typeof HeartbeatBody>;

const ExistingInstallationRow = v.object({
  auth_mode: v.picklist(AUTH_MODES),
  auth_subject: v.nullable(v.string()),
  revoked_at: v.nullable(v.string()),
});

/** An installation owned by a dashboard user; the status query reads device installations only. */
const InstallationRow = v.omit(BalanceRunner, ['online', 'capabilities']);

interface HeartbeatRequest extends RunnerRequest {
  env: RunnerRequest['env'] & { DB: D1<'first' | 'run'> & D1Batch<'first' | 'run'> };
  text(): Promise<string>;
}

interface StatusRequest {
  env: { DB: D1<'all'> };
  user?: { id: string };
}

function isOnline(row: { seconds_since_heartbeat: number }): boolean {
  return row.seconds_since_heartbeat <= ONLINE_SECONDS;
}

function summarize(
  rows: BalanceRunnerCapability[],
  capability: RunnerCapability,
): BalanceRunnerCapabilitySummary {
  const candidates = rows.filter((row) => row.capability === capability);
  const online = candidates.filter((row) => isOnline(row) && row.state !== 'stopping');
  const ready = online.find((row) => row.state === 'ready' || row.state === 'busy');
  const selected = ready ?? online[0] ?? candidates[0];
  if (selected === undefined) {
    return {
      available: false,
      state: 'offline',
      runner_id: null,
      current_job_id: null,
      detail_code: null,
      last_heartbeat: null,
    };
  }
  return {
    available: ready !== undefined,
    state: isOnline(selected) ? selected.state : 'offline',
    runner_id: selected.runner_id,
    current_job_id: selected.current_job_id,
    detail_code: selected.detail_code,
    last_heartbeat: selected.last_heartbeat,
  };
}

/** The runners a dashboard user owns: device installations signed in as that Auth0 subject. */
export async function loadBalanceRunnerStatus(db: D1<'all'>, authSubject: string) {
  const [installations, capabilityRows] = await Promise.all([
    queryAll(
      db
        .prepare(
          `
      SELECT id, display_name, auth_mode, platform, version, last_heartbeat,
        CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER)
          AS seconds_since_heartbeat
      FROM balance_runner_installations
      WHERE revoked_at IS NULL AND auth_mode = 'auth0_device' AND auth_subject = ?
      ORDER BY datetime(last_heartbeat) DESC, id
    `,
        )
        .bind(authSubject),
      InstallationRow,
    ),
    queryAll(
      db
        .prepare(
          `
      SELECT c.runner_id, c.capability, c.state, c.current_job_id, c.concurrency,
        c.detail_code, r.last_heartbeat,
        CAST((julianday('now') - julianday(r.last_heartbeat)) * 86400 AS INTEGER)
          AS seconds_since_heartbeat
      FROM balance_runner_capabilities c
      JOIN balance_runner_installations r ON r.id = c.runner_id
      WHERE r.revoked_at IS NULL AND r.auth_mode = 'auth0_device' AND r.auth_subject = ?
      ORDER BY datetime(r.last_heartbeat) DESC, c.runner_id
    `,
        )
        .bind(authSubject),
      BalanceRunnerCapability,
    ),
  ]);

  return {
    online_seconds: ONLINE_SECONDS,
    capabilities: {
      sms_ai: summarize(capabilityRows, 'sms_ai'),
      carrier_browser: summarize(capabilityRows, 'carrier_browser'),
    } satisfies Record<RunnerCapability, BalanceRunnerCapabilitySummary>,
    runners: installations.map((runner) => ({
      ...runner,
      online: isOnline(runner),
      capabilities: capabilityRows.filter((row) => row.runner_id === runner.id),
    })),
  };
}

export const balanceRunnersHandler = {
  async check(request: RunnerRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.heartbeat);
    if (!auth.authorized) return json({ error: 'Unauthorized' }, 401);
    return json({ success: true });
  },

  async heartbeat(request: HeartbeatRequest): Promise<Response> {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.heartbeat);
    if (!auth.authorized) return json({ error: 'Unauthorized' }, 401);

    const parsed = await readBody(request, HeartbeatBody, HEARTBEAT_MISSING_KEY_MESSAGES);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const heartbeat = parsed.value;

    const existing = await queryFirst(
      request.env.DB.prepare(
        `
      SELECT auth_mode, auth_subject, revoked_at
      FROM balance_runner_installations WHERE id = ?
    `,
      ).bind(heartbeat.runner_id),
      ExistingInstallationRow,
    );
    if (existing !== null && existing.revoked_at !== null) {
      return json({ error: 'Runner installation is revoked' }, 403);
    }
    if (
      existing !== null &&
      (existing.auth_mode !== auth.authMode ||
        (auth.authMode === 'auth0_device' && existing.auth_subject !== auth.subject))
    ) {
      return json({ error: 'Runner identity does not match this installation' }, 409);
    }

    const installation = request.env.DB.prepare(
      `
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version, last_heartbeat
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        auth_mode = excluded.auth_mode,
        auth_subject = excluded.auth_subject,
        platform = excluded.platform,
        version = excluded.version,
        last_heartbeat = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE balance_runner_installations.revoked_at IS NULL
    `,
    ).bind(
      heartbeat.runner_id,
      heartbeat.display_name,
      auth.authMode,
      auth.subject,
      heartbeat.platform,
      heartbeat.version,
    );

    const capabilities = heartbeat.capabilities.map((capability) =>
      request.env.DB.prepare(
        `
        INSERT INTO balance_runner_capabilities (
          runner_id, capability, state, session_id, current_job_id,
          concurrency, detail_code, last_heartbeat
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(runner_id, capability) DO UPDATE SET
          state = excluded.state,
          session_id = excluded.session_id,
          current_job_id = excluded.current_job_id,
          concurrency = excluded.concurrency,
          detail_code = excluded.detail_code,
          last_heartbeat = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `,
      ).bind(
        heartbeat.runner_id,
        capability.capability,
        capability.state,
        heartbeat.session_id,
        capability.current_job_id,
        capability.concurrency,
        capability.detail_code,
      ),
    );

    await request.env.DB.batch([installation, ...capabilities]);
    return json({ success: true, runner_id: heartbeat.runner_id });
  },

  async status(request: StatusRequest): Promise<Response> {
    const authSubject = request.user?.id;
    if (authSubject === undefined || authSubject === '') {
      return json({ error: 'Unauthorized' }, 401);
    }
    return json({
      success: true,
      ...(await loadBalanceRunnerStatus(request.env.DB, authSubject)),
    } satisfies BalanceRunnersResponse);
  },
};
