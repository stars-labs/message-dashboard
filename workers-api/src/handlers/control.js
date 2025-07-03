import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';

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
      
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const stmt = env.DB.prepare(`
          INSERT INTO messages (id, phone_id, phone_number, content, source, timestamp, type, verification_code)
          VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
        `);
        
        const promises = batch.map(msg => {
          const messageId = msg.id || `msg-${nanoid()}`;
          const verificationCode = extractVerificationCode(msg.content);
          
          return stmt.bind(
            messageId,
            msg.phone_id,
            msg.phone_number,
            msg.content,
            msg.source || null,
            msg.timestamp || new Date().toISOString(),
            verificationCode
          ).run();
        });
        
        await Promise.all(promises);
        processed += batch.length;
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
      
      // Update phones
      const stmt = env.DB.prepare(`
        INSERT INTO phones (id, number, country, flag, carrier, status, signal)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          signal = excluded.signal,
          updated_at = CURRENT_TIMESTAMP
      `);
      
      const promises = phones.map(phone => {
        return stmt.bind(
          phone.id,
          phone.number,
          phone.country,
          phone.flag,
          phone.carrier,
          phone.status,
          phone.signal
        ).run();
      });
      
      await Promise.all(promises);
      
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