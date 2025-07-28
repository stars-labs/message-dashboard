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
          p.created_at,
          p.updated_at,
          im.phone_number as mapped_number,
          im.carrier as mapped_carrier,
          im.notes as mapping_notes
        FROM phones p
        LEFT JOIN iccid_mappings im ON p.iccid = im.iccid AND im.is_active = 1
        ORDER BY p.updated_at DESC
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
          SELECT 
            m.id,
            m.phone_iccid,
            m.phone_number,
            COALESCE(im.phone_number, p.number, m.phone_number) as display_phone_number,
            m.content,
            m.timestamp,
            m.type,
            m.status,
            m.verification_code,
            p.carrier as phone_carrier,
            p.status as phone_status,
            im.phone_number as mapped_number
          FROM messages m
          LEFT JOIN phones p ON m.phone_iccid = p.iccid
          LEFT JOIN iccid_mappings im ON m.phone_iccid = im.iccid AND im.is_active = 1
          WHERE m.created_at > ?
          ORDER BY m.timestamp DESC
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