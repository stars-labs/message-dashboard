import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { broadcastEvent } from '../utils/websocket';

export const controlHandler = {
  // Upload messages from Orange Pi
  async uploadMessages(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    
    // Temporary: accept the known API key directly
    const expectedKey = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
    
    if (!apiKey || apiKey !== expectedKey) {
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
          INSERT INTO messages (id, phone_iccid, phone_number, content, source, timestamp, type, verification_code)
          VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
        `);
        
        const promises = batch.map(msg => {
          const messageId = msg.id || `msg-${nanoid()}`;
          const verificationCode = extractVerificationCode(msg.content);
          const timestamp = msg.timestamp || new Date().toISOString();
          
          newMessages.push({
            id: messageId,
            phone_iccid: msg.phone_iccid,
            phone_number: msg.phone_number,
            content: msg.content,
            source: msg.source || null,
            timestamp,
            type: 'received',
            verification_code: verificationCode
          });
          
          return stmt.bind(
            messageId,
            msg.phone_iccid,
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
      // Upload messages error
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
    
    // Temporary: accept the known API key directly until env.API_KEY issue is resolved
    const expectedKey = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
    
    if (!apiKey || apiKey !== expectedKey) {
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
      
      // Update phones using ICCID as primary key
      const stmt = env.DB.prepare(`
        INSERT INTO phones (iccid, number, country, flag, carrier, status, signal, rssi, rsrq, rsrp, snr, operator_name, operator_id, imei, access_tech)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(iccid) DO UPDATE SET
          number = COALESCE(excluded.number, phones.number),
          carrier = COALESCE(excluded.carrier, phones.carrier),
          status = excluded.status,
          signal = excluded.signal,
          rssi = excluded.rssi,
          rsrq = excluded.rsrq,
          rsrp = excluded.rsrp,
          snr = excluded.snr,
          operator_name = COALESCE(excluded.operator_name, phones.operator_name),
          operator_id = COALESCE(excluded.operator_id, phones.operator_id),
          imei = COALESCE(excluded.imei, phones.imei),
          access_tech = excluded.access_tech,
          updated_at = CURRENT_TIMESTAMP
      `);
      
      // Process phones one by one for now to avoid batch issues
      let successCount = 0;
      let errorCount = 0;
      const errors = [];
      
      for (const phone of phones) {
        try {
          // Skip phones without valid ICCIDs
          if (!phone.iccid || phone.iccid.trim() === '') {
            console.log(`[control.js] Skipping phone without ICCID: number=${phone.number}`);
            errorCount++;
            errors.push(`Phone without ICCID (number: ${phone.number || 'unknown'})`);
            continue;
          }
          
          // Log the phone data for debugging
          console.log(`[control.js] Processing phone: iccid=${phone.iccid}, number=${phone.number}`);
          
          await stmt.bind(
            phone.iccid,  // ICCID is now the primary key
            phone.number || null,
            phone.country || null,
            phone.flag || null,
            phone.carrier || null,
            phone.status || 'active',
            phone.signal || null,
            phone.rssi || null,
            phone.rsrq || null,
            phone.rsrp || null,
            phone.snr || null,
            phone.operator_name || null,
            phone.operator_id || null,
            phone.imei || null,
            phone.access_tech || null
          ).run();
          successCount++;
        } catch (err) {
          errorCount++;
          errors.push({
            phone: phone.iccid || phone.number || 'unknown',
            error: err.message
          });
          console.error(`[control.js] Failed to update phone ${phone.iccid || phone.number}:`, err);
        }
      }
      
      console.log(`[control.js] Phone update results: success=${successCount}, errors=${errorCount}`);
      if (errors.length > 0) {
        console.error(`[control.js] Phone update errors:`, errors);
      }
      
      // Filter out invalid phones before broadcasting
      const validPhones = phones.filter(phone => 
        phone.iccid && 
        phone.iccid.trim() !== '' && 
        !phone.iccid.startsWith('SIM_')
      );
      
      // Broadcast phone updates
      console.log(`[control.js] Broadcasting phones:updated event with ${validPhones.length} valid phones (filtered from ${phones.length})`);
      const broadcastResult = await broadcastEvent(env, 'phones:updated', validPhones);
      console.log(`[control.js] Broadcast result:`, broadcastResult);
      
      return new Response(JSON.stringify({
        success: errorCount === 0,
        updated: successCount,
        failed: errorCount,
        message: `Updated ${successCount} phones${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
        errors: errors.length > 0 ? errors : undefined
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Update phones error
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update phones'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Cleanup test data
  async cleanupTestData(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
    
    if (!apiKey || apiKey !== expectedKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { phoneIds } = await request.json();
      
      if (!Array.isArray(phoneIds)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'phoneIds must be an array'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Delete test phones by ICCID
      const placeholders = phoneIds.map(() => '?').join(',');
      const deleteStmt = env.DB.prepare(
        `DELETE FROM phones WHERE iccid IN (${placeholders})`
      );
      
      const result = await deleteStmt.bind(...phoneIds).run();
      
      // Also delete any phones without ICCID
      const cleanupNullIccid = await env.DB.prepare(
        `DELETE FROM phones WHERE iccid IS NULL OR iccid = ''`
      ).run();
      
      return new Response(JSON.stringify({
        success: true,
        deleted: result.meta.changes,
        cleanedNullIccid: cleanupNullIccid.meta.changes,
        message: `Deleted ${result.meta.changes} test phones and ${cleanupNullIccid.meta.changes} phones without ICCID`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Cleanup error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to cleanup test data'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Get pending SMS sends for daemon polling
  async getPendingSMS(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
    
    if (!apiKey || apiKey !== expectedKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      // Get pending SMS messages (status = 'sending')
      const stmt = env.DB.prepare(`
        SELECT id, phone_iccid, phone_number, content, recipient, created_at
        FROM messages 
        WHERE type = 'sent' AND status = 'sending'
        ORDER BY created_at ASC
        LIMIT 50
      `);
      
      const { results } = await stmt.all();
      
      return new Response(JSON.stringify({
        success: true,
        pending_messages: results || []
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Get pending SMS error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to get pending SMS'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Update SMS send result from daemon
  async updateSMSResult(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
    
    if (!apiKey || apiKey !== expectedKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { message_id, success, error_message, sms_id } = await request.json();
      
      if (!message_id) {
        return new Response(JSON.stringify({
          success: false,
          error: 'message_id is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update message status
      const status = success ? 'sent' : 'failed';
      const stmt = env.DB.prepare(`
        UPDATE messages 
        SET status = ?, error_message = ?, sms_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = await stmt.bind(status, error_message || null, sms_id || null, message_id).run();
      
      if (result.meta.changes === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Message not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Broadcast message status update
      await broadcastEvent(env, 'message:status_updated', {
        id: message_id,
        status,
        error_message,
        sms_id
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'SMS result updated successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Update SMS result error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update SMS result'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};