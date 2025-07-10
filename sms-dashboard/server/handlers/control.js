import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { broadcastEvent } from '../utils/websocket';

export const controlHandler = {
  // Upload messages from Orange Pi
  async uploadMessages(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { messages } = await request.json();
      
      if (!Array.isArray(messages)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Messages must be an array'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Process messages in batches
      const batchSize = 50;
      let processed = 0;
      const newMessages = [];
      
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const stmt = env.DB.prepare(`
          INSERT INTO messages (id, phone_id, phone_number, content, source, timestamp, type, verification_code)
          VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
        `);
        
        const promises = batch.map(msg => {
          const messageId = msg.id || `msg-${nanoid()}`;
          const verificationCode = extractVerificationCode(msg.content);
          const timestamp = msg.timestamp || new Date().toISOString();
          
          newMessages.push({
            id: messageId,
            phone_id: msg.phone_id,
            phone_number: msg.phone_number,
            content: msg.content,
            source: msg.source || null,
            timestamp,
            type: 'received',
            verification_code: verificationCode
          });
          
          return stmt.bind(
            messageId,
            msg.phone_id,
            msg.phone_number,
            msg.content,
            msg.source || null,
            timestamp,
            verificationCode
          ).run();
        });
        
        await Promise.all(promises);
        processed += batch.length;
      }
      
      // Broadcast new messages
      if (newMessages.length > 0) {
        await broadcastEvent(env, 'messages:bulk_created', newMessages);
      }
      
      return new Response(JSON.stringify({
        success: true,
        processed,
        message: `Successfully uploaded ${processed} messages`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Upload messages error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to upload messages'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Update phone statuses from Orange Pi
  async updatePhones(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { phones } = await request.json();
      
      if (!Array.isArray(phones)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Phones must be an array'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update phones with ICCID and signal details support
      const stmt = env.DB.prepare(`
        INSERT INTO phones (id, number, country, flag, carrier, status, signal, iccid, rssi, rsrq, rsrp, snr)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          signal = excluded.signal,
          iccid = excluded.iccid,
          rssi = excluded.rssi,
          rsrq = excluded.rsrq,
          rsrp = excluded.rsrp,
          snr = excluded.snr,
          updated_at = CURRENT_TIMESTAMP
      `);
      
      const updatedPhones = [];
      
      for (const phone of phones) {
        // If phone has ICCID but no number, look up the mapping
        if (phone.iccid && !phone.number) {
          const mapping = await env.DB.prepare(`
            SELECT phone_number FROM iccid_mappings 
            WHERE iccid = ? AND is_active = true
          `).bind(phone.iccid).first();
          
          if (mapping) {
            phone.number = mapping.phone_number;
          }
        }
        
        await stmt.bind(
          phone.id,
          phone.number || null,
          phone.country || null,
          phone.flag || null,
          phone.carrier || null,
          phone.status,
          phone.signal || null,
          phone.iccid || null,
          phone.rssi || null,
          phone.rsrq || null,
          phone.rsrp || null,
          phone.snr || null
        ).run();
        
        updatedPhones.push(phone);
      }
      
      // Broadcast phone updates
      await broadcastEvent(env, 'phones:updated', updatedPhones);
      
      return new Response(JSON.stringify({
        success: true,
        updated: phones.length,
        message: `Successfully updated ${phones.length} phones`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Update phones error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update phones'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};