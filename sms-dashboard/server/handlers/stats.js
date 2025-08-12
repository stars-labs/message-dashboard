import { getDeviceStats } from '../utils/device-count.js';

export const statsHandler = {
  async get(request) {
    const { env } = request;
    
    try {
      // Get device statistics from the new normalized tables
      const deviceStats = await getDeviceStats(env.DB);
      
      // Get message statistics
      const stats = await env.DB.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM messages) as total_messages,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now')) as today_messages,
          (SELECT COUNT(*) FROM messages WHERE type = 'sent') as total_sent,
          (SELECT COUNT(*) FROM messages WHERE type = 'received') as total_received,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'sent') as today_sent,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'received') as today_received,
          (SELECT COUNT(*) FROM messages WHERE verification_code IS NOT NULL AND type = 'received') as verified_messages
      `).first();
      
      const verificationRate = stats.total_received > 0 
        ? (stats.verified_messages / stats.total_received) 
        : 0;
      
      // Use device stats from the new normalized tables
      let actualOnlineDevices = deviceStats.online_count;
      let actualTotalDevices = deviceStats.total_count;
      
      // Get daemon status from deviceStats
      let daemonStatus = {
        online: deviceStats.daemon.health === 'healthy' || deviceStats.daemon.health === 'warning',
        last_heartbeat: deviceStats.daemon.last_heartbeat ? new Date(deviceStats.daemon.last_heartbeat).getTime() : null,
        version: null, // Will be set from daemon_health below
        device_id: 'orange-pi-main',
        modem_count: deviceStats.daemon.reported_count
      };
      
      // Get additional daemon info from database
      try {
        const daemonHealth = await env.DB.prepare(`
          SELECT version FROM daemon_health 
          WHERE daemon_id = 'orange-pi-main'
          ORDER BY last_heartbeat DESC
          LIMIT 1
        `).first();
        
        if (daemonHealth && daemonHealth.version) {
          daemonStatus.version = daemonHealth.version;
        }
        
        // If daemon reported a modem count, use it as the total
        if (daemonStatus.online && deviceStats.daemon.reported_count > 0) {
          actualTotalDevices = deviceStats.daemon.reported_count;
        }
      } catch (error) {
        console.error('[stats.js] Failed to get daemon version:', error);
      }
      
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