import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import type { D1, D1Batch } from '../lib/d1.js';
import {
  findRunnerInstallation,
  listAllRunnerInstallations,
  listUserRunnerCapabilities,
  listUserRunnerInstallations,
  recordRunnerHeartbeat,
  revokeRunnerInstallation,
  runnerSessionAdmitted,
} from '../db/balance-runners.js';
import type { AuthorizedRunner } from '../utils/runner-auth.js';
import { LATEST_BALANCE_AGENT } from '../../shared/balance-agent-release.js';
import {
  BalanceRunnerCapability,
  RUNNER_CAPABILITIES,
  type BalanceRunnerCapabilitySummary,
  type BalanceRunnersResponse,
  type RunnerHeartbeatBody,
  type RunnerHeartbeatResponse,
  type RunnerInstallationsResponse,
  type RunnerRevokeResponse,
} from '../../shared/api/balance-runners.js';

const ONLINE_SECONDS = 90;

type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

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
    listUserRunnerInstallations(db, authSubject),
    listUserRunnerCapabilities(db, authSubject),
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
    const existing = await findRunnerInstallation(env.DB, heartbeat.runner_id);
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

    await recordRunnerHeartbeat(env.DB, heartbeat, auth);
    return { success: true, runner_id: heartbeat.runner_id, latest_agent: LATEST_BALANCE_AGENT };
  },

  /** GET /api/balance-runners: the signed-in user's own runners. */
  async status({ env, user }: StatusRequest): Promise<BalanceRunnersResponse> {
    if (user === undefined || user.id === '') throw new ORPCError('UNAUTHORIZED');
    return { success: true, ...(await loadBalanceRunnerStatus(env.DB, user.id)) };
  },

  async installations({ env }: { env: { DB: D1<'all'> } }): Promise<RunnerInstallationsResponse> {
    const rows = await listAllRunnerInstallations(env.DB);
    return {
      success: true,
      runners: rows.map(({ seconds_since_heartbeat, ...runner }) => ({
        ...runner,
        online: runner.revoked_at === null && isOnline({ seconds_since_heartbeat }),
      })),
    };
  },

  async revoke(
    { env }: { env: { DB: D1<'first'> } },
    runnerId: string,
  ): Promise<RunnerRevokeResponse> {
    const revoked = await revokeRunnerInstallation(env.DB, runnerId);
    if (revoked === null) {
      throw new ORPCError('NOT_FOUND', { message: 'Runner installation not found' });
    }
    return { success: true, runner_id: runnerId, revoked_at: revoked.revoked_at };
  },
};

/** Refuses a job call whose session is not a live, unrevoked runner of `auth`'s account. */
export async function requireAdmittedRunnerSession(
  db: D1<'first'>,
  sessionId: string,
  auth: AuthorizedRunner,
): Promise<void> {
  if (!(await runnerSessionAdmitted(db, sessionId, auth))) {
    throw new ORPCError('FORBIDDEN', {
      message: 'Runner session is not registered or its installation is revoked',
    });
  }
}
