export const phonesHandler = {
  // List all phones
  async list(request) {
    const { env } = request;
    
    try {
      if (!env.DB) {
        throw new Error('Database binding not found');
      }
      
      const { results } = await env.DB.prepare(`
        SELECT 
          dv.id,
          dv.iccid,
          dv.number as number,
          dv.country as country,
          dv.flag,
          dv.carrier as carrier,
          dv.status,
          dv.signal,
          dv.rssi,
          dv.rsrq,
          dv.rsrp,
          dv.snr,
          dv.operator_name,
          dv.operator_id,
          dv.imei,
          dv.access_tech,
          dv.modem_index,
          dv.sim_index,
          dv.modem_updated_at as created_at,
          dv.updated_at,
          NULL as mapped_number,
          NULL as mapped_carrier,
          NULL as mapped_country,
          NULL as mapping_notes,
          -- Additional modem/SIM info for frontend
          dv.modem_id,
          dv.modem_manufacturer,
          dv.modem_model,
          dv.modem_status,
          dv.sim_iccid,
          dv.sim_phone_number,
          dv.sim_status,
          dv.usb_port
        FROM device_view dv
        ORDER BY dv.usb_port, dv.iccid
      `).all();
      
      return new Response(JSON.stringify({
        success: true,
        data: results
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Log error details server-side for debugging
      console.error('[Phones] List error:', error.stack || error);
      
      // Return generic error to client without exposing stack trace
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch phones'
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
        SELECT 
          dv.id,
          dv.iccid,
          dv.number as number,
          dv.country,
          dv.flag,
          dv.carrier as carrier,
          dv.status,
          dv.signal,
          dv.rssi,
          dv.rsrq,
          dv.rsrp,
          dv.snr,
          dv.operator_name,
          dv.operator_id,
          dv.imei,
          dv.access_tech,
          dv.modem_index,
          dv.sim_index,
          dv.modem_updated_at as created_at,
          dv.updated_at,
          NULL as mapped_number,
          NULL as mapped_carrier,
          NULL as mapping_notes,
          dv.modem_id,
          dv.modem_status,
          dv.sim_status
        FROM device_view dv
        WHERE dv.iccid = ? OR dv.id = ?
      `).bind(phoneId, phoneId).first();
      
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