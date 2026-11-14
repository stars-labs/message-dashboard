import * as v from 'valibot';

export const HEALTH_SCHEMA_VERSION = 3;

/** Ages in seconds. `null` means "never happened"; the daemon omits them on first boot. */
const Age = v.nullable(v.number());

/** The normalized snapshot the daemon uploads, stored as JSON in daemon_health.metadata. */
export const HealthSnapshot = v.object({
  schema_version: v.literal(HEALTH_SCHEMA_VERSION),
  session_id: v.string(),
  version: v.string(),
  uptime_seconds: v.number(),
  last_message_read_success_age_seconds: Age,
  last_upload_success_age_seconds: Age,
  queue: v.object({
    pending: v.number(),
    in_flight: v.number(),
    dead_letter: v.number(),
    oldest_unacknowledged_age_seconds: Age,
  }),
});

export type HealthSnapshot = v.InferOutput<typeof HealthSnapshot>;

export const DAEMON_HEALTH_STATUSES = ['unknown', 'offline', 'degraded', 'healthy'] as const;

const DaemonHealthStatus = v.picklist(DAEMON_HEALTH_STATUSES);

/**
 * GET /api/daemon/status: the daemon's last heartbeat, or, before it has ever
 * connected, why there is none.
 */
export const DaemonStatusResponse = v.union([
  v.object({
    status: DaemonHealthStatus,
    label: v.string(),
    message: v.optional(v.string()),
    reasons: v.array(v.string()),
    snapshot: v.null(),
    timestamp: v.string(),
  }),
  v.object({
    daemon_id: v.string(),
    status: DaemonHealthStatus,
    label: v.string(),
    last_heartbeat: v.string(),
    seconds_since_heartbeat: v.nullable(v.number()),
    message: v.string(),
    reasons: v.array(v.string()),
    snapshot: v.nullable(HealthSnapshot),
    timestamp: v.string(),
  }),
]);

export type DaemonStatusResponse = v.InferOutput<typeof DaemonStatusResponse>;
