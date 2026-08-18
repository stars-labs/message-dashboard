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
          dv.equipment_id as imei,
          dv.iccid,
          dv.number,
          dv.country,
          dv.carrier,
          dv.service_type,
          dv.service_type_source,
          dv.service_type_verified_at,
          dv.sim_role,
          dv.primary_iccid,
          dv.sim_status as status,
          dv.signal_quality as signal,
          dv.operator,
          dv.manufacturer,
          dv.model,
          dv.primary_port as usb_port,
          dv.usb_path,
          dv.last_usb_path,
          dv.modem_status,
          dv.sim_index,
          dv.notes,
          dv.created_at,
          dv.updated_at
        FROM device_view dv
        ORDER BY dv.primary_port, dv.iccid
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
          dv.equipment_id as imei,
          dv.iccid,
          dv.number,
          dv.country,
          dv.carrier,
          dv.service_type,
          dv.service_type_source,
          dv.service_type_verified_at,
          dv.sim_role,
          dv.primary_iccid,
          dv.sim_status as status,
          dv.signal_quality as signal,
          dv.operator,
          dv.manufacturer,
          dv.model,
          dv.primary_port as usb_port,
          dv.usb_path,
          dv.last_usb_path,
          dv.modem_status,
          dv.sim_index,
          dv.notes,
          dv.created_at,
          dv.updated_at
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
