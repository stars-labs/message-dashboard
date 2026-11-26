import * as v from 'valibot';
import { bodyObject } from './body.js';

export const RUNNER_CAPABILITIES = ['sms_ai', 'carrier_browser'] as const;

export const RUNNER_STATES = [
  'starting',
  'ready',
  'busy',
  'degraded',
  'configuration_required',
  'stopping',
] as const;

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

/** The runner chosen for the capability, or offline when none is. */
export const BalanceRunnerCapabilitySummary = v.object({
  available: v.boolean(),
  state: v.picklist([...RUNNER_STATES, 'offline']),
  runner_id: v.nullable(v.string()),
  current_job_id: v.nullable(v.string()),
  detail_code: v.nullable(v.string()),
  last_heartbeat: v.nullable(v.string()),
});

export type BalanceRunnerCapabilitySummary = v.InferOutput<typeof BalanceRunnerCapabilitySummary>;

export const BalanceRunnerCapabilities = v.object({
  sms_ai: BalanceRunnerCapabilitySummary,
  carrier_browser: BalanceRunnerCapabilitySummary,
});

export type BalanceRunnerCapabilities = v.InferOutput<typeof BalanceRunnerCapabilities>;

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

export const BalanceRunnersResponse = v.object({
  success: v.literal(true),
  online_seconds: v.number(),
  capabilities: BalanceRunnerCapabilities,
  runners: v.array(BalanceRunner),
});

export type BalanceRunnersResponse = v.InferOutput<typeof BalanceRunnersResponse>;

/** An installation as an admin sees it: anyone's, revoked or not. */
export const RunnerInstallation = v.object({
  id: v.string(),
  display_name: v.string(),
  auth_mode: v.picklist(['legacy_api_key', 'auth0_device']),
  auth_subject: v.nullable(v.string()),
  platform: v.string(),
  version: v.string(),
  last_heartbeat: v.string(),
  online: v.boolean(),
  revoked_at: v.nullable(v.string()),
});

export type RunnerInstallation = v.InferOutput<typeof RunnerInstallation>;

export const RunnerInstallationsResponse = v.object({
  success: v.literal(true),
  runners: v.array(RunnerInstallation),
});

export type RunnerInstallationsResponse = v.InferOutput<typeof RunnerInstallationsResponse>;

export const RunnerRevokeResponse = v.object({
  success: v.literal(true),
  runner_id: v.string(),
  revoked_at: v.string(),
});

export type RunnerRevokeResponse = v.InferOutput<typeof RunnerRevokeResponse>;

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

/** Each capability at most once. */
export const RunnerHeartbeatBody = bodyObject(
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
  {
    runner_id: INVALID_HEARTBEAT,
    session_id: INVALID_HEARTBEAT,
    display_name: INVALID_HEARTBEAT,
    platform: INVALID_HEARTBEAT,
    version: INVALID_HEARTBEAT,
    capabilities: INVALID_HEARTBEAT,
  },
  INVALID_HEARTBEAT,
);

export const RunnerHeartbeatResponse = v.object({
  success: v.literal(true),
  runner_id: v.string(),
});

export type RunnerHeartbeatResponse = v.InferOutput<typeof RunnerHeartbeatResponse>;

export const RunnerCheckResponse = v.object({ success: v.literal(true) });

export type RunnerCheckResponse = v.InferOutput<typeof RunnerCheckResponse>;
