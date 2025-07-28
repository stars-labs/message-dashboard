// Polling updates handler
export const updatesHandler = {
  async poll(request) {
    const { env, user } = request;
    const url = new URL(request.url);
    const since = url.searchParams.get('since');
    
    try {
      const updates = [];
      
      // Fetch current phone data to check for updates
      const { results: phones } = await env.DB.prepare(`
        SELECT iccid, number, country, flag, carrier, status, signal, 
               rssi, rsrq, rsrp, snr, operator_name, operator_id, imei, access_tech, 
               created_at, updated_at
        FROM phones 
        ORDER BY updated_at DESC
      `).all();
      
      // If we have phones data, send it as an update
      // In a real implementation, you'd check if data changed since 'since' timestamp
      if (phones && phones.length > 0) {
        updates.push({
          type: 'phones:updated',
          data: phones,
          timestamp: new Date().toISOString()
        });
      }
      
      // Check for recent messages if 'since' is provided
      if (since) {
        const { results: messages } = await env.DB.prepare(`
          SELECT id, phone_iccid, phone_number, content, timestamp, type, status, verification_code
          FROM messages 
          WHERE created_at > ?
          ORDER BY timestamp DESC
          LIMIT 50
        `).bind(since).all();
        
        if (messages && messages.length > 0) {
          updates.push({
            type: 'messages:bulk_created',
            data: messages,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        updates: updates,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('[Updates] Poll error:', error);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Failed to fetch updates' 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};