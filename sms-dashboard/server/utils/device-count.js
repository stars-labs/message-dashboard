/**
 * Simple utility for consistent device counting
 * Single source of truth for device statistics
 */

export async function getDeviceStats(db) {
  // Get counts from the actual tables (source of truth)
  const stats = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM modems WHERE status IN ('connected', 'registered', 'active')) as connected_modems,
      (SELECT COUNT(*) FROM modems WHERE status = 'disconnected') as disconnected_modems,
      (SELECT COUNT(*) FROM modems) as total_modems,
      (SELECT COUNT(*) FROM device_view WHERE sim_status = 'active') as active_sims,
      (SELECT COUNT(*) FROM device_view WHERE sim_status IN ('no_modem', 'unassigned')) as inactive_sims,
      (SELECT COUNT(*) FROM device_view WHERE sim_status IN ('sim_error', 'iccid_mismatch', 'offline')) as error_sims
  `).first();

  const totalSims = (stats.active_sims || 0) + (stats.inactive_sims || 0) + (stats.error_sims || 0);

  // Get daemon status from daemon_health table
  const daemonHealth = await db.prepare(`
    SELECT
      status as daemon_status,
      modem_count as reported_modem_count,
      last_heartbeat,
      version,
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
    modems: {
      total: stats.total_modems || 0,
      connected: stats.connected_modems || 0,
      disconnected: stats.disconnected_modems || 0,
    },
    sims: {
      total: totalSims,
      active: stats.active_sims || 0,
      inactive: stats.inactive_sims || 0,
      error: stats.error_sims || 0
    },
    daemon: {
      status: daemonHealth?.daemon_status || 'unknown',
      health: daemonHealth?.health_status || 'offline',
      reported_count: daemonHealth?.reported_modem_count || 0,
      last_heartbeat: daemonHealth?.last_heartbeat || null,
      version: daemonHealth?.version || null
    },
    // Simple counts for UI
    online_count: stats.active_sims || 0,
    total_count: totalSims
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