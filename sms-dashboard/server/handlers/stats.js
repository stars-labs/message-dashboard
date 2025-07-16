export const statsHandler = {
  async get(request) {
    const { env } = request;
    
    try {
      // Optimize with a single query for all stats
      const stats = await env.DB.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM messages) as total_messages,
          (SELECT COUNT(*) FROM messages WHERE date(timestamp) = date('now')) as today_messages,
          (SELECT COUNT(*) FROM phones WHERE status = 'online') as online_devices,
          (SELECT COUNT(*) FROM phones) as total_devices,
          (SELECT COUNT(*) FROM messages WHERE verification_code IS NOT NULL AND type = 'received') as verified_messages,
          (SELECT COUNT(*) FROM messages WHERE type = 'received') as total_received
      `).first();
      
      const verificationRate = stats.total_received > 0 
        ? (stats.verified_messages / stats.total_received) 
        : 0;
      
      return new Response(JSON.stringify({
        success: true,
        total_messages: stats.total_messages,
        today_messages: stats.today_messages,
        online_devices: stats.online_devices,
        total_devices: stats.total_devices,
        verification_rate: verificationRate
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