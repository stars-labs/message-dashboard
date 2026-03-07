import { getDeviceStats } from '../utils/device-count.js';

export const statsHandler = {
  async get(request) {
    const { env } = request;
    
    try {
      // Get device statistics from the new normalized tables
      const deviceStats = await getDeviceStats(env.DB);
      
      // Get message statistics with a single optimized query
      const stats = await env.DB.prepare(`
        SELECT 
          COUNT(*) as total_messages,
          COUNT(CASE WHEN date(timestamp) = date('now') THEN 1 END) as today_messages,
          COUNT(CASE WHEN type = 'sent' THEN 1 END) as total_sent,
          COUNT(CASE WHEN type = 'received' THEN 1 END) as total_received,
          COUNT(CASE WHEN date(timestamp) = date('now') AND type = 'sent' THEN 1 END) as today_sent,
          COUNT(CASE WHEN date(timestamp) = date('now') AND type = 'received' THEN 1 END) as today_received,
          COUNT(CASE WHEN verification_code IS NOT NULL AND type = 'received' THEN 1 END) as verified_messages
        FROM messages
      `).first();
      
      const verificationRate = stats.total_received > 0 
        ? (stats.verified_messages / stats.total_received) 
        : 0;
      
      // Use device stats from the new normalized tables
      let actualOnlineDevices = deviceStats.online_count;
      let actualTotalDevices = deviceStats.total_count;
      
      let daemonStatus = {
        online: deviceStats.daemon.health === 'healthy' || deviceStats.daemon.health === 'warning',
        last_heartbeat: deviceStats.daemon.last_heartbeat ? new Date(deviceStats.daemon.last_heartbeat).getTime() : null,
        version: deviceStats.daemon.version,
        device_id: 'orange-pi-main',
        modem_count: deviceStats.daemon.reported_count
      };
      
      return new Response(JSON.stringify({
        success: true,
        total_messages: stats.total_messages,
        today_messages: stats.today_messages,
        total_sent: stats.total_sent,
        total_received: stats.total_received,
        today_sent: stats.today_sent,
        today_received: stats.today_received,
        online_devices: actualOnlineDevices,
        total_devices: actualTotalDevices,
        sim_missing_devices: deviceStats.sim_missing_count || 0,
        verification_rate: verificationRate,
        daemon_status: daemonStatus
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Error handling - stats
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch statistics'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};