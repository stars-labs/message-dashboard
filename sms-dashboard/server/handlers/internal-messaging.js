import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';

export const internalMessagingHandler = {
  // Simulate internal message delivery between system phones
  async deliverInternalMessage(env, senderIccid, recipientPhone, content, originalMessageId) {
    try {
      // Create a received message for the recipient
      const receivedMessageId = `msg-received-${nanoid()}`;
      const timestamp = new Date().toISOString();
      const verificationCode = extractVerificationCode(content);
      
      // Get sender phone details
      const senderPhone = await env.DB.prepare(`
        SELECT number FROM phones WHERE iccid = ?
      `).bind(senderIccid).first();
      
      console.log(`[Internal Messaging] Delivering message from ${senderPhone?.number} to ${recipientPhone.number}`);
      
      // Insert received message for recipient
      await env.DB.prepare(`
        INSERT INTO messages (
          id, 
          phone_iccid, 
          phone_number, 
          content, 
          timestamp, 
          type, 
          verification_code,
          metadata
        )
        VALUES (?, ?, ?, ?, ?, 'received', ?, ?)
      `).bind(
        receivedMessageId,
        recipientPhone.iccid,
        senderPhone?.number || 'Unknown',
        content,
        timestamp,
        verificationCode,
        JSON.stringify({
          internal_delivery: true,
          sender_iccid: senderIccid,
          original_message_id: originalMessageId,
          simulated: true
        })
      ).run();
      
      // Update original message status to 'delivered'
      await env.DB.prepare(`
        UPDATE messages 
        SET status = 'delivered', 
            updated_at = CURRENT_TIMESTAMP,
            metadata = json_set(
              COALESCE(metadata, '{}'),
              '$.delivered_message_id', ?
            )
        WHERE id = ?
      `).bind(receivedMessageId, originalMessageId).run();
      
      // Broadcast the new received message via WebSocket
      try {
        const ws = env.WEBSOCKET_HANDLER.get(env.WEBSOCKET_HANDLER.idFromName('broadcast'));
        await ws.fetch('http://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'message',
            data: {
              id: receivedMessageId,
              phone_iccid: recipientPhone.iccid,
              phone_number: senderPhone?.number || 'Unknown',
              content,
              timestamp,
              type: 'received',
              verification_code: verificationCode,
              internal_delivery: true
            }
          })
        });
      } catch (wsError) {
        console.error('[Internal Messaging] WebSocket broadcast failed:', wsError);
      }
      
      return {
        success: true,
        delivered_message_id: receivedMessageId,
        sender: senderPhone?.number,
        recipient: recipientPhone.number
      };
    } catch (error) {
      console.error('[Internal Messaging] Delivery failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  },
  
  // Process pending internal messages
  async processPendingInternal(request) {
    const { env } = request;
    
    try {
      // Find internal messages that should be delivered instantly
      const pendingInternal = await env.DB.prepare(`
        SELECT 
          m.id,
          m.phone_iccid as sender_iccid,
          m.recipient,
          m.content,
          m.metadata
        FROM messages m
        WHERE m.type = 'sent' 
          AND m.status = 'sending'
          AND json_extract(m.metadata, '$.internal') = true
        ORDER BY m.created_at ASC
        LIMIT 10
      `).all();
      
      const results = [];
      
      for (const message of pendingInternal.results || []) {
        // Check if recipient is still online
        const recipientPhone = await env.DB.prepare(`
          SELECT iccid, number, status FROM phones 
          WHERE (number = ? OR iccid = ?)
            AND status IN ('online', 'active', 'registered')
        `).bind(message.recipient, message.recipient).first();
        
        if (recipientPhone) {
          // Deliver the internal message
          const deliveryResult = await this.deliverInternalMessage(
            env,
            message.sender_iccid,
            recipientPhone,
            message.content,
            message.id
          );
          
          results.push({
            message_id: message.id,
            ...deliveryResult
          });
        } else {
          // Mark as failed if recipient is no longer online
          await env.DB.prepare(`
            UPDATE messages 
            SET status = 'failed', 
                error_message = 'Recipient offline or not found',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(message.id).run();
          
          results.push({
            message_id: message.id,
            success: false,
            error: 'Recipient offline or not found'
          });
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        processed: results.length,
        results
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Internal Messaging] Processing failed:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};