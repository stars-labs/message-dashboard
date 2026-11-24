import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';
import type { AuthorizedRunner } from '../utils/runner-auth.js';
import {
  BalanceRunner,
  BalanceRunnerCapability,
  RUNNER_CAPABILITIES,
  type BalanceRunnerCapabilitySummary,
  type BalanceRunnersResponse,
  type RunnerHeartbeatBody,
  type RunnerHeartbeatResponse,
} from '../../shared/api/balance-runners.js';

const ONLINE_SECONDS = 90;

const AUTH_MODES = ['legacy_api_key', 'auth0_device'] as const;

type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

const ExistingInstallationRow = v.object({
  auth_mode: v.picklist(AUTH_MODES),
  auth_subject: v.nullable(v.string()),
  revoked_at: v.nullable(v.string()),
});

/** An installation owned by a dashboard user; the status query reads device installations only. */
const InstallationRow = v.omit(BalanceRunner, ['online', 'capabilities']);

/** A heartbeat as the contract hands it over, once the runner has been admitted. */
interface HeartbeatCall {
  env: { DB: D1<'first' | 'run'> & D1Batch<'first' | 'run'> };
}

interface StatusRequest {
  env: { DB: D1<'all'> };
  user?: { id: string } | undefined;
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
  async heartbeat(
    { env }: HeartbeatCall,
    auth: AuthorizedRunner,
    heartbeat: v.InferOutput<typeof RunnerHeartbeatBody>,
  ): Promise<RunnerHeartbeatResponse> {
    const existing = await queryFirst(
      env.DB.prepare(
        `
      SELECT auth_mode, auth_subject, revoked_at
      FROM balance_runner_installations WHERE id = ?
    `,
      ).bind(heartbeat.runner_id),
      ExistingInstallationRow,
    );
    if (existing !== null && existing.revoked_at !== null) {
      throw new ORPCError('FORBIDDEN', { message: 'Runner installation is revoked' });
    }
    if (
      existing !== null &&
      (existing.auth_mode !== auth.authMode ||
        (auth.authMode === 'auth0_device' && existing.auth_subject !== auth.subject))
    ) {
      throw new ORPCError('CONFLICT', {
        message: 'Runner identity does not match this installation',
      });
    }

    const installation = env.DB.prepare(
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
      env.DB.prepare(
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

    await env.DB.batch([installation, ...capabilities]);
    return { success: true, runner_id: heartbeat.runner_id };
  },

  /** GET /api/balance-runners: the signed-in user's own runners. */
  async status({ env, user }: StatusRequest): Promise<BalanceRunnersResponse> {
    if (user === undefined || user.id === '') throw new ORPCError('UNAUTHORIZED');
    return { success: true, ...(await loadBalanceRunnerStatus(env.DB, user.id)) };
  },
};
