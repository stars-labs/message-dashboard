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
      
      // Fetch current device data to check for updates
      const { results: phones } = await env.DB.prepare(`
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
          NULL as mapping_notes
        FROM device_view dv
        ORDER BY dv.updated_at DESC
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
            COALESCE(dv.number, m.phone_number) as display_phone_number,
            m.content,
            m.timestamp,
            m.type,
            m.status,
            m.recipient,
            m.verification_code,
            dv.carrier as phone_carrier,
            dv.status as phone_status,
            dv.user_phone_number as mapped_number
          FROM messages m
          LEFT JOIN device_view dv ON m.phone_iccid = dv.iccid
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
            COALESCE(dv.number, m.phone_number) as display_phone_number,
            m.content,
            m.timestamp,
            m.type,
            m.status,
            m.recipient,
            m.verification_code,
            dv.carrier as phone_carrier,
            dv.status as phone_status,
            dv.user_phone_number as mapped_number
          FROM messages m
          LEFT JOIN device_view dv ON m.phone_iccid = dv.iccid
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