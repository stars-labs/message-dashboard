import { deriveDaemonHealth } from '../utils/daemon-health.js';

const DAEMON_HEALTH_SELECT = `
  SELECT *,
    CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) AS seconds_since_heartbeat
  FROM daemon_health
  WHERE daemon_id = 'orange-pi-main'
`;

export const healthHandler = {
  async check(request) {
    const { env } = request;
    
    try {
      // Test database connection
      const result = await env.DB.prepare('SELECT 1 as test').first();
      
      let daemonHealth = null;
      try {
        daemonHealth = await env.DB.prepare(DAEMON_HEALTH_SELECT).first();
      } catch (err) {
        console.error('Failed to check daemon health:', err);
      }
      
      const derived = deriveDaemonHealth(daemonHealth);
      return new Response(JSON.stringify({
        status: 'healthy',
        database: result ? 'connected' : 'error',
        daemon: {
          status: derived.status,
          label: derived.label,
          reasons: derived.reasons,
          legacy: derived.legacy,
          last_heartbeat: daemonHealth?.last_heartbeat ?? null,
        },
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  async daemonStatus(request) {
    const { env } = request;
    
    try {
      const daemonHealth = await env.DB.prepare(DAEMON_HEALTH_SELECT).first();
      
      if (!daemonHealth) {
        const derived = deriveDaemonHealth(null);
        return new Response(JSON.stringify({
          status: derived.status,
          label: derived.label,
          message: derived.reasons[0],
          reasons: derived.reasons,
          modem_count: 0,
          tasks: null,
          queue: null,
          modems: null,
          legacy: false,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const derived = deriveDaemonHealth(daemonHealth);
      const snapshot = derived.snapshot;
      const actualModemCount = derived.status === 'offline'
        ? 0
        : (snapshot?.modems?.discovered ?? daemonHealth.modem_count ?? 0);
      
      return new Response(JSON.stringify({
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
        tasks: snapshot?.tasks ?? null,
        queue: snapshot?.queue ?? null,
        modems: snapshot?.modems ?? null,
        uptime_seconds: snapshot?.uptime_seconds ?? null,
        legacy: derived.legacy,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
