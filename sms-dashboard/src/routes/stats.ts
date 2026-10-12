import { Elysia, t } from 'elysia';
import { sql, eq, and, gte } from 'drizzle-orm';
import { phones, messages, modems, sims, daemon_health } from '../db/schema';

export const statsRoutes = new Elysia({ prefix: '/stats' })
  .get('/', async ({ db }) => {
    // Get device counts
    const [totalDevices] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(phones);
    
    const [onlineDevices] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(phones)
      .where(eq(phones.status, 'online'));
    
    // Get message counts
    const [totalMessages] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(messages);
    
    const [todayMessages] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(messages)
      .where(gte(messages.timestamp, sql`DATE('now', 'start of day')`));
    
    // Get daemon health
    const daemonStatus = await db
      .select({
        daemon_id: daemon_health.daemon_id,
        hostname: daemon_health.hostname,
        status: daemon_health.status,
        connected_modems: daemon_health.connected_modems,
        active_sims: daemon_health.active_sims,
        last_heartbeat: daemon_health.last_heartbeat,
        uptime_seconds: daemon_health.uptime_seconds
      })
      .from(daemon_health)
      .orderBy(sql`${daemon_health.last_heartbeat} DESC`)
      .limit(1);
    
    // Get carrier distribution
    const carrierStats = await db
      .select({
        carrier: phones.carrier,
        count: sql<number>`COUNT(*)`
      })
      .from(phones)
      .where(sql`${phones.carrier} IS NOT NULL`)
      .groupBy(phones.carrier);
    
    // Get status distribution
    const statusStats = await db
      .select({
        status: phones.status,
        count: sql<number>`COUNT(*)`
      })
      .from(phones)
      .groupBy(phones.status);
    
    // Get signal quality distribution
    const signalStats = await db
      .select({
        range: sql<string>`
          CASE 
            WHEN signal >= 75 THEN 'Excellent'
            WHEN signal >= 50 THEN 'Good'
            WHEN signal >= 25 THEN 'Fair'
            ELSE 'Poor'
          END
        `,
        count: sql<number>`COUNT(*)`
      })
      .from(phones)
      .where(sql`${phones.signal} IS NOT NULL`)
      .groupBy(sql`
        CASE 
          WHEN signal >= 75 THEN 'Excellent'
          WHEN signal >= 50 THEN 'Good'
          WHEN signal >= 25 THEN 'Fair'
          ELSE 'Poor'
        END
      `);
    
    return {
      devices: {
        total: totalDevices?.count || 0,
        online: onlineDevices?.count || 0,
        offline: (totalDevices?.count || 0) - (onlineDevices?.count || 0)
      },
      messages: {
        total: totalMessages?.count || 0,
        today: todayMessages?.count || 0
      },
      daemon: daemonStatus[0] || null,
      carriers: carrierStats,
      statuses: statusStats,
      signal_quality: signalStats
    };
  })
  
  // Get time series data for charts
  .get('/timeseries', async ({ db, query }) => {
    const { period = '24h' } = query;
    
    let interval: string;
    let startTime: any;
    
    switch (period) {
      case '1h':
        interval = '5 minutes';
        startTime = sql`datetime('now', '-1 hour')`;
        break;
      case '24h':
        interval = '1 hour';
        startTime = sql`datetime('now', '-24 hours')`;
        break;
      case '7d':
        interval = '6 hours';
        startTime = sql`datetime('now', '-7 days')`;
        break;
      case '30d':
        interval = '1 day';
        startTime = sql`datetime('now', '-30 days')`;
        break;
      default:
        interval = '1 hour';
        startTime = sql`datetime('now', '-24 hours')`;
    }
    
    // Get message counts over time
    const messageTimeSeries = await db
      .select({
        timestamp: sql<string>`strftime('%Y-%m-%d %H:00:00', timestamp)`,
        received: sql<number>`COUNT(CASE WHEN type = 'received' THEN 1 END)`,
        sent: sql<number>`COUNT(CASE WHEN type = 'sent' THEN 1 END)`
      })
      .from(messages)
      .where(gte(messages.timestamp, startTime))
      .groupBy(sql`strftime('%Y-%m-%d %H:00:00', timestamp)`)
      .orderBy(sql`timestamp`);
    
    return {
      period,
      messages: messageTimeSeries
    };
  }, {
    query: t.Object({
      period: t.Optional(t.Union([
        t.Literal('1h'),
        t.Literal('24h'),
        t.Literal('7d'),
        t.Literal('30d')
      ]))
    })
  });