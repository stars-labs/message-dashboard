import { getDeviceStats } from '../utils/device-count.js';
import { success, error } from '../utils/api-response.js';

export const statsHandler = {
  async get(request) {
    const { env } = request;
    
    try {
      // Get message statistics
      const messageStats = await env.DB.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM messages) as total_messages,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now')) as today_messages,
          (SELECT COUNT(*) FROM messages WHERE type = 'sent') as total_sent,
          (SELECT COUNT(*) FROM messages WHERE type = 'received') as total_received,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'sent') as today_sent,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'received') as today_received,
          (SELECT COUNT(*) FROM messages WHERE verification_code IS NOT NULL AND type = 'received') as verified_messages
      `).first();
      
      // Get device statistics from single source of truth
      const deviceStats = await getDeviceStats(env.DB);
      
      const verificationRate = messageStats.total_received > 0 
        ? (messageStats.verified_messages / messageStats.total_received) 
        : 0;
      
      // Simple daemon status from device stats
      const daemonStatus = {
        online: deviceStats.daemon.health === 'healthy',
        last_heartbeat: deviceStats.daemon.last_heartbeat,
        version: null, // Can be added to daemon_health table if needed
        device_id: 'orange-pi-main',
        modem_count: deviceStats.daemon.reported_count
      };
      
      // Try to get version from KV if available
      try {
        const heartbeatData = await env.SESSIONS.get('daemon:heartbeat');
        if (heartbeatData) {
          const heartbeat = JSON.parse(heartbeatData);
          daemonStatus.version = heartbeat.version;
        }
      } catch (error) {
        console.error('[stats.js] Failed to get daemon version from KV:', error);
      }
      
      return success({
        total_messages: messageStats.total_messages,
        today_messages: messageStats.today_messages,
        total_sent: messageStats.total_sent,
        total_received: messageStats.total_received,
        today_sent: messageStats.today_sent,
        today_received: messageStats.today_received,
        online_devices: deviceStats.online_count,
        total_devices: deviceStats.total_count,
        verification_rate: verificationRate,
        daemon_status: daemonStatus
      });
    } catch (err) {
      console.error('[stats.js] Error fetching statistics:', err);
      return error('Failed to fetch statistics');
    }
  }
};