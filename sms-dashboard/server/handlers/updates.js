// Polling updates handler
export const updatesHandler = {
  async poll(request) {
    const { env, user } = request;
    const url = new URL(request.url);
    const latestMessageId = url.searchParams.get('latest_message_id');
    const latestTimestamp = url.searchParams.get('latest_timestamp');
    
    console.log('[Updates] Poll request:', {
      latestMessageId,
      latestTimestamp,
      query: url.search
    });
    
    try {
      const updates = [];
      
      // Fetch current phone data to check for updates
      const { results: phones } = await env.DB.prepare(`
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
      } else {
        // Still send an update but with empty array to ensure frontend gets valid data
        updates.push({
          type: 'phones:updated',
          data: [],
          timestamp: new Date().toISOString()
        });
      }
      
      // Check for new messages based on latest tracking info
      let shouldCheckMessages = true;
      let messagesQuery;
      
      if (latestMessageId && latestTimestamp) {
        console.log(`[Updates] Checking for messages newer than: ${latestTimestamp} (ID: ${latestMessageId})`);
        
        // Get messages newer than the latest known message
        messagesQuery = env.DB.prepare(`
          SELECT 
            m.id,
            m.phone_iccid,
            m.phone_number,
            COALESCE(im.phone_number, p.number, m.phone_number) as display_phone_number,
            m.content,
            m.timestamp,
            m.type,
            m.status,
            m.recipient,
            m.verification_code,
            p.carrier as phone_carrier,
            p.status as phone_status,
            im.phone_number as mapped_number
          FROM messages m
          LEFT JOIN phones p ON m.phone_iccid = p.iccid
          LEFT JOIN iccid_mappings im ON m.phone_iccid = im.iccid AND im.is_active = 1
          WHERE m.timestamp > ?
          ORDER BY m.timestamp DESC
          LIMIT 20
        `).bind(latestTimestamp);
      } else {
        console.log(`[Updates] First poll - getting latest messages`);
        
        // First poll - get latest messages
        messagesQuery = env.DB.prepare(`
          SELECT 
            m.id,
            m.phone_iccid,
            m.phone_number,
            COALESCE(im.phone_number, p.number, m.phone_number) as display_phone_number,
            m.content,
            m.timestamp,
            m.type,
            m.status,
            m.recipient,
            m.verification_code,
            p.carrier as phone_carrier,
            p.status as phone_status,
            im.phone_number as mapped_number
          FROM messages m
          LEFT JOIN phones p ON m.phone_iccid = p.iccid
          LEFT JOIN iccid_mappings im ON m.phone_iccid = im.iccid AND im.is_active = 1
          ORDER BY m.timestamp DESC
          LIMIT 10
        `);
      }
      
      const { results: messages } = await messagesQuery.all();
      
      if (messages && messages.length > 0) {
        console.log(`[Updates] Found ${messages.length} message(s) to return:`);
        messages.forEach((msg, idx) => {
          console.log(`  ${idx + 1}. ${msg.id}: "${msg.content.substring(0, 30)}..." at ${msg.timestamp}`);
        });
        
        updates.push({
          type: 'messages:bulk_created',
          data: messages,
          timestamp: new Date().toISOString()
        });
      } else {
        console.log(`[Updates] No new messages found`);
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