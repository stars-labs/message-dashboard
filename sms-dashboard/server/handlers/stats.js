export const statsHandler = {
  async get(request) {
    const { env } = request;
    
    try {
      // Optimize with a single query for all stats
      // Only count phones as online if they've been updated recently (within 5 minutes)
      const stats = await env.DB.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM messages) as total_messages,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now')) as today_messages,
          (SELECT COUNT(*) FROM messages WHERE type = 'sent') as total_sent,
          (SELECT COUNT(*) FROM messages WHERE type = 'received') as total_received,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'sent') as today_sent,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now') AND type = 'received') as today_received,
          (SELECT COUNT(*) FROM phones WHERE status IN ('online', 'active', 'registered') AND datetime(updated_at) > datetime('now', '-5 minutes')) as online_devices,
          (SELECT COUNT(*) FROM phones) as total_devices,
          (SELECT COUNT(*) FROM messages WHERE verification_code IS NOT NULL AND type = 'received') as verified_messages
      `).first();
      
      const verificationRate = stats.total_received > 0 
        ? (stats.verified_messages / stats.total_received) 
        : 0;
      
      // Check daemon heartbeat from KV and database
      let daemonStatus = {
        online: false,
        last_heartbeat: null,
        version: null,
        device_id: null,
        modem_count: null
      };
      
      let actualOnlineDevices = stats.online_devices;
      let actualTotalDevices = stats.total_devices;
      
      try {
        // First check KV for heartbeat
        const heartbeatData = await env.KV.get('daemon:heartbeat');
        if (heartbeatData) {
          const heartbeat = JSON.parse(heartbeatData);
          const now = Date.now();
          const fiveMinutesAgo = now - (5 * 60 * 1000);
          
          daemonStatus = {
            online: heartbeat.last_heartbeat > fiveMinutesAgo,
            last_heartbeat: heartbeat.last_heartbeat,
            version: heartbeat.version,
            device_id: heartbeat.device_id,
            modem_count: heartbeat.modem_count
          };
        }
        
        // Also check database for daemon health
        const daemonHealth = await env.DB.prepare(`
          SELECT * FROM daemon_health 
          WHERE daemon_id = 'orange-pi-main'
          ORDER BY last_heartbeat DESC
          LIMIT 1
        `).first();
        
        if (daemonHealth) {
          const now = Date.now();
          const lastHeartbeat = new Date(daemonHealth.last_heartbeat).getTime();
          const isOnline = (now - lastHeartbeat) < 5 * 60 * 1000;
          
          // Use database modem count if more recent or KV doesn't have it
          if (!daemonStatus.modem_count || 
              (daemonHealth.last_heartbeat && lastHeartbeat > daemonStatus.last_heartbeat)) {
            daemonStatus.modem_count = daemonHealth.modem_count;
            daemonStatus.online = isOnline;
          }
          
          // When daemon is online, use its modem count as the source of truth for total devices
          if (isOnline && daemonHealth.modem_count !== null && daemonHealth.modem_count !== undefined) {
            console.log('[Stats] Using daemon modem count:', daemonHealth.modem_count);
            // Daemon now reports ALL modems including those without SIM cards
            actualTotalDevices = daemonHealth.modem_count; // This will be 55 (all modems)
            // Online devices excludes modems with sim-missing status
            const onlineExcludingSIMissing = await env.DB.prepare(`
              SELECT COUNT(*) as count 
              FROM phones 
              WHERE status IN ('online', 'active', 'registered') 
                AND datetime(updated_at) > datetime('now', '-5 minutes')
                AND iccid NOT LIKE 'NO_SIM_MODEM_%'
            `).first();
            if (onlineExcludingSIMissing) {
              actualOnlineDevices = onlineExcludingSIMissing.count;
            }
          }
        }
      } catch (error) {
        console.error('[stats.js] Failed to get daemon status:', error);
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