export const healthHandler = {
  async check(request) {
    const { env } = request;
    
    try {
      // Test database connection
      const result = await env.DB.prepare('SELECT 1 as test').first();
      
      // Check daemon health
      let daemonHealth = null;
      try {
        // Create table if not exists
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS daemon_health (
            daemon_id TEXT PRIMARY KEY,
            last_heartbeat TIMESTAMP NOT NULL,
            status TEXT DEFAULT 'online',
            last_ip TEXT,
            version TEXT,
            modem_count INTEGER DEFAULT 0,
            error_count INTEGER DEFAULT 0,
            last_error TEXT,
            metadata TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `).run();
        
        daemonHealth = await env.DB.prepare(`
          SELECT *, 
            CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) as seconds_since_heartbeat
          FROM daemon_health 
          WHERE daemon_id = 'orange-pi-main'
        `).first();
        
        // If daemon hasn't checked in for more than 2 minutes, mark as offline
        if (daemonHealth && daemonHealth.seconds_since_heartbeat > 120) {
          daemonHealth.status = 'offline';
          daemonHealth.health_warning = 'Daemon has not checked in for ' + Math.floor(daemonHealth.seconds_since_heartbeat / 60) + ' minutes';
        }
      } catch (err) {
        console.error('Failed to check daemon health:', err);
      }
      
      return new Response(JSON.stringify({
        status: 'healthy',
        database: result ? 'connected' : 'error',
        daemon: daemonHealth || { status: 'unknown', message: 'No daemon data available' },
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
      // Create table if not exists
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS daemon_health (
          daemon_id TEXT PRIMARY KEY,
          last_heartbeat TIMESTAMP NOT NULL,
          status TEXT DEFAULT 'online',
          last_ip TEXT,
          version TEXT,
          modem_count INTEGER DEFAULT 0,
          error_count INTEGER DEFAULT 0,
          last_error TEXT,
          metadata TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      
      const daemonHealth = await env.DB.prepare(`
        SELECT *, 
          CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) as seconds_since_heartbeat
        FROM daemon_health 
        WHERE daemon_id = 'orange-pi-main'
      `).first();
      
      if (!daemonHealth) {
        return new Response(JSON.stringify({
          status: 'unknown',
          message: '等待守护进程连接',
          modem_count: 0,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Determine actual status based on last heartbeat
      let actualStatus = daemonHealth.status;
      let healthMessage = '';
      let actualModemCount = daemonHealth.modem_count || 0;
      
      if (daemonHealth.seconds_since_heartbeat > 300) { // 5 minutes
        actualStatus = 'offline';
        healthMessage = `守护进程离线 ${Math.floor(daemonHealth.seconds_since_heartbeat / 60)} 分钟`;
        // Don't show stale modem count when offline
        actualModemCount = 0;
      } else if (daemonHealth.seconds_since_heartbeat > 120) { // 2 minutes
        actualStatus = 'warning';
        healthMessage = `${daemonHealth.seconds_since_heartbeat} 秒未收到心跳`;
        // Show modem count but with warning
      } else {
        healthMessage = `正常运行中`;
      }
      
      return new Response(JSON.stringify({
        daemon_id: daemonHealth.daemon_id,
        status: actualStatus,
        last_heartbeat: daemonHealth.last_heartbeat,
        seconds_since_heartbeat: daemonHealth.seconds_since_heartbeat,
        message: healthMessage,
        modem_count: actualModemCount,
        error_count: daemonHealth.error_count,
        last_error: daemonHealth.last_error,
        last_ip: daemonHealth.last_ip,
        version: daemonHealth.version,
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