export const statsHandler = {
  async get(request) {
    const { env } = request;
    
    try {
      const [totalMessages, todayMessages, onlineDevices, totalDevices] = await Promise.all([
        // Total messages
        env.DB.prepare(`SELECT COUNT(*) as count FROM messages`).first(),
        
        // Today's messages
        env.DB.prepare(`
          SELECT COUNT(*) as count FROM messages 
          WHERE date(timestamp) = date('now')
        `).first(),
        
        // Online devices
        env.DB.prepare(`SELECT COUNT(*) as count FROM phones WHERE status = 'online'`).first(),
        
        // Total devices
        env.DB.prepare(`SELECT COUNT(*) as count FROM phones`).first(),
      ]);
      
      // Calculate verification rate
      const verifiedMessages = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM messages 
        WHERE verification_code IS NOT NULL AND type = 'received'
      `).first();
      
      const totalReceived = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM messages WHERE type = 'received'
      `).first();
      
      const verificationRate = totalReceived.count > 0 
        ? (verifiedMessages.count / totalReceived.count) 
        : 0;
      
      return new Response(JSON.stringify({
        success: true,
        data: {
          total_messages: totalMessages.count,
          today_messages: todayMessages.count,
          online_devices: onlineDevices.count,
          total_devices: totalDevices.count,
          verification_rate: verificationRate
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Stats error:', error);
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