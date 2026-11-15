import * as v from 'valibot';

/** GET /api/live: the Worker answers. */
export const LiveResponse = v.object({ status: v.literal('alive'), timestamp: v.string() });

export type LiveResponse = v.InferOutput<typeof LiveResponse>;

/**
 * GET /api/health when D1 answers and the daemon is healthy. Anything else is a
 * 503 problem whose `health` member has this shape with the failing status.
 */
export const HealthResponse = v.object({
  status: v.literal('healthy'),
  database: v.object({ status: v.literal('connected') }),
  daemon: v.object({
    status: v.literal('healthy'),
    label: v.string(),
    reasons: v.array(v.string()),
    last_heartbeat: v.nullable(v.string()),
  }),
  timestamp: v.string(),
});

export type HealthResponse = v.InferOutput<typeof HealthResponse>;
