import { deriveDaemonHealth } from '../utils/daemon-health.js';
import { classifyD1Error, logD1Error } from '../utils/d1-error.js';

const DAEMON_HEALTH_SELECT = `
  SELECT *,
    CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) AS seconds_since_heartbeat
  FROM daemon_health
  WHERE daemon_id = 'orange-pi-main'
`;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function unavailableBody(classification, timestamp) {
  const database = {
    status: 'unavailable',
    code: classification.code,
  };
  if (classification.quota) database.quota = classification.quota;
  if (classification.retryAt) database.retry_at = classification.retryAt.toISOString();

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

function unavailableHeaders(classification) {
  return classification.retryAt
    ? { 'Retry-After': classification.retryAt.toUTCString() }
    : {};
}

export const healthHandler = {
  async live() {
    return json({
      status: 'alive',
      timestamp: new Date().toISOString(),
    });
  },

  async check(request) {
    const { env } = request;
    const timestamp = new Date().toISOString();

    try {
      // One indexed application-table read proves D1 is usable and supplies the
      // daemon state. A constant SELECT 1 can succeed after table reads are blocked.
      const daemonHealth = await env.DB.prepare(DAEMON_HEALTH_SELECT).first();
      const derived = deriveDaemonHealth(daemonHealth);
      return json({
        status: derived.status,
        database: { status: 'connected' },
        daemon: {
          status: derived.status,
          label: derived.label,
          reasons: derived.reasons,
          last_heartbeat: daemonHealth?.last_heartbeat ?? null,
        },
        timestamp,
      }, derived.status === 'healthy' ? 200 : 503);
    } catch (error) {
      const classification = classifyD1Error(error);
      logD1Error('health_readiness', error, classification);
      return json(
        unavailableBody(classification, timestamp),
        503,
        unavailableHeaders(classification),
      );
    }
  },
  
  async daemonStatus(request) {
    const { env } = request;
    
    try {
      const daemonHealth = await env.DB.prepare(DAEMON_HEALTH_SELECT).first();
      
      if (!daemonHealth) {
        const derived = deriveDaemonHealth(null);
        return json({
          status: derived.status,
          label: derived.label,
          message: derived.reasons[0],
          reasons: derived.reasons,
          modem_count: 0,
          tasks: null,
          queue: null,
          modems: null,
          timestamp: new Date().toISOString(),
        });
      }
      
      const derived = deriveDaemonHealth(daemonHealth);
      const snapshot = derived.snapshot;
      const actualModemCount = derived.status === 'offline' ? 0 : (daemonHealth.modem_count ?? 0);
      
      return json({
        daemon_id: daemonHealth.daemon_id,
        status: derived.status,
        label: derived.label,
        last_heartbeat: daemonHealth.last_heartbeat,
        seconds_since_heartbeat: daemonHealth.seconds_since_heartbeat,
        message: derived.reasons[0] || '正常运行中',
        reasons: derived.reasons,
        modem_count: actualModemCount,
        error_count: daemonHealth.error_count,
        last_error: daemonHealth.last_error,
        last_ip: daemonHealth.last_ip,
        version: snapshot?.version ?? daemonHealth.version,
        session_id: snapshot?.session_id ?? daemonHealth.current_session_id,
        tasks: null,
        queue: snapshot?.queue ?? null,
        modems: null,
        uptime_seconds: snapshot?.uptime_seconds ?? null,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const classification = classifyD1Error(error);
      logD1Error('daemon_status', error, classification);
      return json({
        status: 'error',
        code: classification.code,
        message: 'Service status is temporarily unavailable',
        retry_at: classification.retryAt?.toISOString() ?? null,
        timestamp: new Date().toISOString(),
      }, 503, unavailableHeaders(classification));
    }
  }
};
