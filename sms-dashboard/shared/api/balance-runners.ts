import * as v from 'valibot';

/** The work a Balance Agent runner can take on. */
export const RUNNER_CAPABILITIES = ['sms_ai', 'carrier_browser'] as const;

/** The states a runner reports for one capability. */
export const RUNNER_STATES = [
  'starting',
  'ready',
  'busy',
  'degraded',
  'configuration_required',
  'stopping',
] as const;

/** A capability joined with its installation's heartbeat. */
export const BalanceRunnerCapability = v.object({
  runner_id: v.string(),
  capability: v.picklist(RUNNER_CAPABILITIES),
  state: v.picklist(RUNNER_STATES),
  current_job_id: v.nullable(v.string()),
  concurrency: v.number(),
  detail_code: v.nullable(v.string()),
  last_heartbeat: v.string(),
  seconds_since_heartbeat: v.number(),
});

export type BalanceRunnerCapability = v.InferOutput<typeof BalanceRunnerCapability>;

/** One capability across all runners: the runner chosen for it, or offline when none is. */
export const BalanceRunnerCapabilitySummary = v.object({
  available: v.boolean(),
  state: v.picklist([...RUNNER_STATES, 'offline']),
  runner_id: v.nullable(v.string()),
  current_job_id: v.nullable(v.string()),
  detail_code: v.nullable(v.string()),
  last_heartbeat: v.nullable(v.string()),
});

export type BalanceRunnerCapabilitySummary = v.InferOutput<typeof BalanceRunnerCapabilitySummary>;

/** The summary of each capability, keyed by capability name. */
export const BalanceRunnerCapabilities = v.object({
  sms_ai: BalanceRunnerCapabilitySummary,
  carrier_browser: BalanceRunnerCapabilitySummary,
});

export type BalanceRunnerCapabilities = v.InferOutput<typeof BalanceRunnerCapabilities>;

/** A device installation of a dashboard user's Balance Agent, with its capabilities. */
export const BalanceRunner = v.object({
  id: v.string(),
  display_name: v.string(),
  auth_mode: v.literal('auth0_device'),
  platform: v.string(),
  version: v.string(),
  last_heartbeat: v.string(),
  seconds_since_heartbeat: v.number(),
  online: v.boolean(),
  capabilities: v.array(BalanceRunnerCapability),
});

export type BalanceRunner = v.InferOutput<typeof BalanceRunner>;

/** GET /api/balance-runners. */
export const BalanceRunnersResponse = v.object({
  success: v.literal(true),
  online_seconds: v.number(),
  capabilities: BalanceRunnerCapabilities,
  runners: v.array(BalanceRunner),
});

export type BalanceRunnersResponse = v.InferOutput<typeof BalanceRunnersResponse>;
