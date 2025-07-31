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
          p.iccid,
          COALESCE(im.phone_number, p.number) as number,
          COALESCE(im.country, p.country) as country,
          p.flag,
          COALESCE(im.carrier, p.carrier) as carrier,
          p.status,
          p.signal,
          p.rssi,
          p.rsrq,
          p.rsrp,
          p.snr,
          p.operator_name,
          p.operator_id,
          p.imei,
          p.access_tech,
          p.modem_index,
          p.sim_index,
          p.created_at,
          p.updated_at,
          im.phone_number as mapped_number,
          im.carrier as mapped_carrier,
          im.country as mapped_country,
          im.notes as mapping_notes
        FROM phones p
        LEFT JOIN iccid_mappings im ON p.iccid = im.iccid AND im.is_active = 1
        ORDER BY p.iccid
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
          p.iccid,
          COALESCE(im.phone_number, p.number) as number,
          p.country,
          p.flag,
          COALESCE(im.carrier, p.carrier) as carrier,
          p.status,
          p.signal,
          p.rssi,
          p.rsrq,
          p.rsrp,
          p.snr,
          p.operator_name,
          p.operator_id,
          p.imei,
          p.access_tech,
          p.modem_index,
          p.sim_index,
          p.created_at,
          p.updated_at,
          im.phone_number as mapped_number,
          im.carrier as mapped_carrier,
          im.notes as mapping_notes
        FROM phones p
        LEFT JOIN iccid_mappings im ON p.iccid = im.iccid AND im.is_active = 1
        WHERE p.iccid = ?
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