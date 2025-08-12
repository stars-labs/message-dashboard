/**
 * Simple utility for consistent device counting
 * Single source of truth for device statistics
 */

export async function getDeviceStats(db) {
  // Get counts from the actual tables (source of truth)
  const stats = await db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM modems WHERE status IN ('connected', 'registered')) as connected_modems,
      (SELECT COUNT(*) FROM modems WHERE status = 'disconnected') as disconnected_modems,
      (SELECT COUNT(*) FROM modems) as total_modems,
      (SELECT COUNT(*) FROM sims WHERE status = 'active') as active_sims,
      (SELECT COUNT(*) FROM sims WHERE status = 'inactive') as inactive_sims,
      (SELECT COUNT(DISTINCT current_modem_id) FROM sims WHERE current_modem_id IS NOT NULL) as modems_with_sims
  `).first();
  
  // Calculate totals
  const totalModems = stats.total_modems || 0;
  const totalSims = (stats.active_sims || 0) + (stats.inactive_sims || 0);
  
  // Get daemon status from daemon_health table
  const daemonHealth = await db.prepare(`
    SELECT 
      status as daemon_status,
      modem_count as reported_modem_count,
      last_heartbeat,
      CASE 
        WHEN datetime(last_heartbeat) > datetime('now', '-2 minutes') THEN 'healthy'
        WHEN datetime(last_heartbeat) > datetime('now', '-5 minutes') THEN 'warning'
        ELSE 'offline'
      END as health_status
    FROM daemon_health
    WHERE daemon_id = 'orange-pi-main'
    ORDER BY last_heartbeat DESC
    LIMIT 1
  `).first();
  
  return {
    // Actual counts from database
    modems: {
      total: totalModems,
      connected: stats.connected_modems || 0,
      disconnected: stats.disconnected_modems || 0,
      with_sims: stats.modems_with_sims || 0
    },
    sims: {
      total: totalSims,
      active: stats.active_sims || 0,
      inactive: stats.inactive_sims || 0
    },
    // Daemon reported values (for comparison)
    daemon: {
      status: daemonHealth?.daemon_status || 'unknown',
      health: daemonHealth?.health_status || 'offline',
      reported_count: daemonHealth?.reported_modem_count || 0,
      last_heartbeat: daemonHealth?.last_heartbeat || null
    },
    // Simple online count for UI
    online_count: stats.connected_modems || 0,
    total_count: totalModems
  };
}

/**
 * Get simple count for mobile view
 */
export async function getSimpleDeviceCount(db) {
  const stats = await getDeviceStats(db);
  return {
    online: stats.online_count,
    total: stats.total_count
  };
}