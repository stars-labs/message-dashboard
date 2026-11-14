import * as v from 'valibot';
import { queryFirst, type D1 } from '../lib/d1.js';
import { json } from '../lib/response.js';
import type { DaemonStatusResponse } from '../../shared/api/daemon-status.js';
import { deriveDaemonHealth } from '../utils/daemon-health.js';
import { classifyD1Error, logD1Error } from '../utils/d1-error.js';
import type { D1ErrorClassification } from '../utils/d1-error.js';

interface HealthRequest {
  env: { DB: D1<'first'> };
}

const DAEMON_HEALTH_SELECT = `
  SELECT daemon_id, last_heartbeat, metadata,
    CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) AS seconds_since_heartbeat
  FROM daemon_health
  WHERE daemon_id = 'orange-pi-main'
`;

/** julianday() of an unreadable last_heartbeat is NULL, so the age can be null. */
const DaemonHealthRow = v.object({
  daemon_id: v.string(),
  last_heartbeat: v.string(),
  metadata: v.nullable(v.string()),
  seconds_since_heartbeat: v.nullable(v.number()),
});

function uncached(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return json(body, status, { 'Cache-Control': 'no-store', ...headers });
}

function unavailableBody(classification: D1ErrorClassification, timestamp: string) {
  const database = {
    status: 'unavailable',
    code: classification.code,
    ...(classification.quota ? { quota: classification.quota } : {}),
    ...(classification.retryAt ? { retry_at: classification.retryAt.toISOString() } : {}),
  };

  return {
    status: 'unavailable',
    database,
    daemon: {
      status: 'unknown',
      label: 'Unavailable',
      reasons: ['Database dependency is unavailable'],
      last_heartbeat: null,
    },
    timestamp,
  };
}

function unavailableHeaders(classification: D1ErrorClassification): Record<string, string> {
  return classification.retryAt ? { 'Retry-After': classification.retryAt.toUTCString() } : {};
}

export const healthHandler = {
  live(): Response {
    return uncached({
      status: 'alive',
      timestamp: new Date().toISOString(),
    });
  },

  async check(request: HealthRequest): Promise<Response> {
    const { env } = request;
    const timestamp = new Date().toISOString();

    try {
      // One indexed application-table read proves D1 is usable and supplies the
      // daemon state. A constant SELECT 1 can succeed after table reads are blocked.
      const daemonHealth = await queryFirst(env.DB.prepare(DAEMON_HEALTH_SELECT), DaemonHealthRow);
      const derived = deriveDaemonHealth(daemonHealth);
      return uncached(
        {
          status: derived.status,
          database: { status: 'connected' },
          daemon: {
            status: derived.status,
            label: derived.label,
            reasons: derived.reasons,
            last_heartbeat: daemonHealth?.last_heartbeat ?? null,
          },
          timestamp,
        },
        derived.status === 'healthy' ? 200 : 503,
      );
    } catch (error) {
      const classification = classifyD1Error(error);
      logD1Error('health_readiness', error, classification);
      return uncached(
        unavailableBody(classification, timestamp),
        503,
        unavailableHeaders(classification),
      );
    }
  },

  async daemonStatus(request: HealthRequest): Promise<Response> {
    const { env } = request;

    try {
      const daemonHealth = await queryFirst(env.DB.prepare(DAEMON_HEALTH_SELECT), DaemonHealthRow);

      if (!daemonHealth) {
        const derived = deriveDaemonHealth(null);
        return uncached({
          status: derived.status,
          label: derived.label,
          message: derived.reasons[0],
          reasons: derived.reasons,
          snapshot: null,
          timestamp: new Date().toISOString(),
        } satisfies DaemonStatusResponse);
      }

      const derived = deriveDaemonHealth(daemonHealth);
      const snapshot = derived.snapshot;

      return uncached({
        daemon_id: daemonHealth.daemon_id,
        status: derived.status,
        label: derived.label,
        last_heartbeat: daemonHealth.last_heartbeat,
        seconds_since_heartbeat: daemonHealth.seconds_since_heartbeat,
        message: derived.reasons[0] ?? '正常运行中',
        reasons: derived.reasons,
        snapshot,
        timestamp: new Date().toISOString(),
      } satisfies DaemonStatusResponse);
    } catch (error) {
      const classification = classifyD1Error(error);
      logD1Error('daemon_status', error, classification);
      return uncached(
        {
          status: 'error',
          code: classification.code,
          message: 'Service status is temporarily unavailable',
          retry_at: classification.retryAt?.toISOString() ?? null,
          timestamp: new Date().toISOString(),
        },
        503,
        unavailableHeaders(classification),
      );
    }
  },
};
