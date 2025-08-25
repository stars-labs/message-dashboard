import { eq, sql, desc } from 'drizzle-orm';
import { createDb } from '../db/client';
import { daemon_health, modems, sims, modem_state } from '../db/schema';
import type { Context } from 'hono';

// Custom type for our context with bindings
type AppContext = Context<{
  Bindings: {
    DB: D1Database;
    [key: string]: any;
  };
  Variables: {
    db: ReturnType<typeof createDb>;
    user?: any;
    userPermissions?: string[];
  };
}>;

export const healthHandler = {
  // Basic health check
  async check(c: AppContext) {
    try {
      // Use raw D1 query to check the new sims table (with fallback to phones for compatibility)
      let result;
      try {
        result = await c.env.DB.prepare('SELECT COUNT(*) as count FROM sims').first();
      } catch (e) {
        // Fallback to phones table if sims doesn't exist
        result = await c.env.DB.prepare('SELECT COUNT(*) as count FROM phones').first();
      }

      return c.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected',
        phone_count: result?.count || 0
      });
    } catch (error: any) {
      console.error('[Health] Check error:', error);
      return c.json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'error',
        error: error.message
      }, 503);
    }
  },

  // Daemon status check
  async daemonStatus(c: AppContext) {
    const db = c.get('db');
    
    try {
      // Get all daemon health records
      const daemons = await db
        .select()
        .from(daemon_health)
        .orderBy(desc(daemon_health.last_heartbeat));

      // Get modem and SIM statistics
      const stats = await db
        .select({
          total_modems: sql<number>`COUNT(DISTINCT ${modems.equipment_id})`,
          connected_modems: sql<number>`SUM(CASE WHEN ${modems.status} = 'connected' THEN 1 ELSE 0 END)`,
          total_sims: sql<number>`COUNT(DISTINCT ${sims.iccid})`,
          active_sims: sql<number>`SUM(CASE WHEN ${sims.status} = 'active' THEN 1 ELSE 0 END)`
        })
        .from(modems)
        .leftJoin(sims, eq(sims.current_modem_id, modems.equipment_id));

      // Check if daemons are online (heartbeat within last 2 minutes)
      const now = Date.now();
      const daemonStatuses = daemons.map(d => {
        const lastHeartbeat = new Date(d.last_heartbeat).getTime();
        const isOnline = (now - lastHeartbeat) < 120000; // 2 minutes
        
        return {
          daemon_id: d.daemon_id,
          status: isOnline ? 'online' : 'offline',
          last_heartbeat: d.last_heartbeat,
          last_ip: d.last_ip,
          version: d.version,
          modem_count: d.modem_count,
          error_count: d.error_count,
          last_error: d.last_error,
          metadata: d.metadata ? JSON.parse(d.metadata) : null
        };
      });

      // Overall system health
      const hasOnlineDaemons = daemonStatuses.some(d => d.status === 'online');
      const systemHealth = {
        status: hasOnlineDaemons ? 'healthy' : 'degraded',
        message: hasOnlineDaemons 
          ? 'System operational' 
          : 'No active daemons detected',
        timestamp: new Date().toISOString()
      };

      return c.json({
        success: true,
        system: systemHealth,
        daemons: daemonStatuses,
        statistics: stats[0] || {
          total_modems: 0,
          connected_modems: 0,
          total_sims: 0,
          active_sims: 0
        }
      });
    } catch (error: any) {
      console.error('[Health] Daemon status error:', error);
      return c.json({
        success: false,
        error: 'Failed to fetch daemon status'
      }, 500);
    }
  },

  // Get detailed system metrics
  async metrics(c: AppContext) {
    const db = c.get('db');
    
    try {
      // Get modem state statistics
      const signalStats = await db
        .select({
          avg_signal: sql<number>`AVG(${modem_state.signal_percent})`,
          min_signal: sql<number>`MIN(${modem_state.signal_percent})`,
          max_signal: sql<number>`MAX(${modem_state.signal_percent})`,
          total_connected: sql<number>`SUM(CASE WHEN ${modem_state.connection_status} = 'registered' THEN 1 ELSE 0 END)`,
          total_searching: sql<number>`SUM(CASE WHEN ${modem_state.connection_status} = 'searching' THEN 1 ELSE 0 END)`,
          total_denied: sql<number>`SUM(CASE WHEN ${modem_state.connection_status} = 'denied' THEN 1 ELSE 0 END)`
        })
        .from(modem_state);

      // Get error statistics
      const errorStats = await db
        .select({
          modems_with_errors: sql<number>`SUM(CASE WHEN ${modems.error_count} > 0 THEN 1 ELSE 0 END)`,
          total_errors: sql<number>`SUM(${modems.error_count})`,
          daemons_with_errors: sql<number>`SUM(CASE WHEN ${daemon_health.error_count} > 0 THEN 1 ELSE 0 END)`,
          daemon_errors: sql<number>`SUM(${daemon_health.error_count})`
        })
        .from(modems)
        .crossJoin(daemon_health);

      // Get recent activity
      const recentActivity = await db
        .select({
          recently_updated_modems: sql<number>`
            SUM(CASE WHEN datetime(${modems.updated_at}) > datetime('now', '-5 minutes') THEN 1 ELSE 0 END)
          `,
          recently_updated_sims: sql<number>`
            SUM(CASE WHEN datetime(${sims.updated_at}) > datetime('now', '-5 minutes') THEN 1 ELSE 0 END)
          `
        })
        .from(modems)
        .crossJoin(sims);

      return c.json({
        success: true,
        metrics: {
          signal: signalStats[0] || {},
          errors: errorStats[0] || {},
          activity: recentActivity[0] || {},
          timestamp: new Date().toISOString()
        }
      });
    } catch (error: any) {
      console.error('[Health] Metrics error:', error);
      return c.json({
        success: false,
        error: 'Failed to fetch system metrics'
      }, 500);
    }
  }
};