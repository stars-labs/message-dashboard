export const phonesHandler = {
  // List all phones
  async list(request) {
    const { env } = request;
    
    try {
      if (!env.DB) {
        throw new Error('Database binding not found');
      }
      
      const { results } = await env.DB.prepare(`
        SELECT iccid, number, country, flag, carrier, status, signal, 
               rssi, rsrq, rsrp, snr, operator_name, operator_id, imei, access_tech, 
               created_at, updated_at
        FROM phones 
        ORDER BY iccid
      `).all();
      
      return new Response(JSON.stringify({
        success: true,
        data: results
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Error handling - list phones
      return new Response(JSON.stringify({
        success: false,
        error: error.message || 'Failed to fetch phones',
        details: error.stack
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Get specific phone
  async get(request) {
    const { env } = request;
    const phoneId = request.params.id;
    
    try {
      const phone = await env.DB.prepare(`
        SELECT iccid, number, country, flag, carrier, status, signal, 
               rssi, rsrq, rsrp, snr, operator_name, operator_id, imei, access_tech, 
               created_at, updated_at
        FROM phones 
        WHERE iccid = ?
      `).bind(phoneId).first();
      
      if (!phone) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Phone not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({
        success: true,
        data: phone
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Error handling - get phone
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch phone'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};