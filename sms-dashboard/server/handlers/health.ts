import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { queryFirst, type D1 } from '../lib/d1.js';
import type { DaemonStatusResponse } from '../../shared/api/daemon-status.js';
import type { HealthResponse, LiveResponse } from '../../shared/api/health.js';
import { deriveDaemonHealth } from '../utils/daemon-health.js';
import { classifyD1Error, logD1Error } from '../utils/d1-error.js';
import type { D1ErrorClassification } from '../utils/d1-error.js';

interface HealthCall {
  env: { DB: D1<'first'> };
  /** Headers to add to the answer, error or not. */
  resHeaders: Headers;
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

/** Health answers describe this moment; nothing between here and the monitor may keep one. */
function uncached(resHeaders: Headers): void {
  resHeaders.set('Cache-Control', 'no-store');
}

function retryAfter(classification: D1ErrorClassification, resHeaders: Headers): void {
  if (classification.retryAt) resHeaders.set('Retry-After', classification.retryAt.toUTCString());
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

/** Readiness failed: a 503 whose `health` member says what is not ready. */
function notHealthy(detail: string, health: object): ORPCError<'NOT_HEALTHY', { health: object }> {
  return new ORPCError('NOT_HEALTHY', { status: 503, message: detail, data: { health } });
}

export const healthHandler = {
  live({ resHeaders }: Pick<HealthCall, 'resHeaders'>): LiveResponse {
    uncached(resHeaders);
    return { status: 'alive', timestamp: new Date().toISOString() };
  },

  async check({ env, resHeaders }: HealthCall): Promise<HealthResponse> {
    uncached(resHeaders);
    const timestamp = new Date().toISOString();

    let daemonHealth;
    try {
      // One indexed application-table read proves D1 is usable and supplies the
      // daemon state. A constant SELECT 1 can succeed after table reads are blocked.
      daemonHealth = await queryFirst(env.DB.prepare(DAEMON_HEALTH_SELECT), DaemonHealthRow);
    } catch (error) {
      const classification = classifyD1Error(error);
      logD1Error('health_readiness', error, classification);
      retryAfter(classification, resHeaders);
      throw notHealthy(
        'Database dependency is unavailable',
        unavailableBody(classification, timestamp),
      );
    }

    const derived = deriveDaemonHealth(daemonHealth);
    const daemon = {
      label: derived.label,
      reasons: derived.reasons,
      last_heartbeat: daemonHealth?.last_heartbeat ?? null,
    };
    if (derived.status !== 'healthy') {
      throw notHealthy(derived.reasons[0] ?? derived.label, {
        status: derived.status,
        database: { status: 'connected' },
        daemon: { status: derived.status, ...daemon },
        timestamp,
      });
    }
    return {
      status: 'healthy',
      database: { status: 'connected' },
      daemon: { status: 'healthy', ...daemon },
      timestamp,
    };
  },

  async daemonStatus({ env, resHeaders }: HealthCall): Promise<DaemonStatusResponse> {
    uncached(resHeaders);

    let daemonHealth;
    try {
      daemonHealth = await queryFirst(env.DB.prepare(DAEMON_HEALTH_SELECT), DaemonHealthRow);
    } catch (error) {
      const classification = classifyD1Error(error);
      logD1Error('daemon_status', error, classification);
      retryAfter(classification, resHeaders);
      throw new ORPCError(classification.code, {
        status: 503,
        message: 'Service status is temporarily unavailable',
        data: { retry_at: classification.retryAt?.toISOString() ?? null },
      });
    }

    if (!daemonHealth) {
      const derived = deriveDaemonHealth(null);
      return {
        status: derived.status,
        label: derived.label,
        ...(derived.reasons[0] === undefined ? {} : { message: derived.reasons[0] }),
        reasons: derived.reasons,
        snapshot: null,
        timestamp: new Date().toISOString(),
      };
    }

    const derived = deriveDaemonHealth(daemonHealth);
    return {
      daemon_id: daemonHealth.daemon_id,
      status: derived.status,
      label: derived.label,
      last_heartbeat: daemonHealth.last_heartbeat,
      seconds_since_heartbeat: daemonHealth.seconds_since_heartbeat,
      message: derived.reasons[0] ?? '正常运行中',
      reasons: derived.reasons,
      snapshot: derived.snapshot,
      timestamp: new Date().toISOString(),
    };
  },
};
