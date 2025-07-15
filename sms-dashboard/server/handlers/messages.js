import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { broadcastEvent } from '../utils/websocket';
import { broadcastSSEEvent } from './sse';

export const messagesHandler = {
  // List messages with pagination
  async list(request) {
    const { env } = request;
    const url = new URL(request.url);
    const phoneId = url.searchParams.get('phone_id');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    
    try {
      let query = `SELECT * FROM messages`;
      let countQuery = `SELECT COUNT(*) as total FROM messages`;
      const params = [];
      
      if (phoneId) {
        query += ` WHERE phone_iccid = ?`;
        countQuery += ` WHERE phone_iccid = ?`;
        params.push(phoneId);
      }
      
      query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      const [messages, count] = await Promise.all([
        env.DB.prepare(query).bind(...params).all(),
        env.DB.prepare(countQuery).bind(...(phoneId ? [phoneId] : [])).first()
      ]);
      
      return new Response(JSON.stringify({
        success: true,
        data: messages.results,
        pagination: {
          total: count.total,
          limit,
          offset
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Error handling - list messages
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch messages'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Get specific message
  async get(request) {
    const { env } = request;
    const messageId = request.params.id;
    
    try {
      const message = await env.DB.prepare(`
        SELECT * FROM messages WHERE id = ?
      `).bind(messageId).first();
      
      if (!message) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Message not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({
        success: true,
        data: message
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Error handling - get message
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch message'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Send SMS
  async send(request) {
    const { env } = request;
    
    try {
      const body = await request.json();
      const { phoneId, recipient, content } = body;
      
      // Validate input
      if (!phoneId || !recipient || !content) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Get phone details
      const phone = await env.DB.prepare(`
        SELECT * FROM phones WHERE iccid = ? AND status = 'online'
      `).bind(phoneId).first();
      
      if (!phone) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Phone not found or offline'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Create message record
      const messageId = `msg-sent-${nanoid()}`;
      const timestamp = new Date().toISOString();
      
      await env.DB.prepare(`
        INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, recipient, status)
        VALUES (?, ?, ?, ?, ?, 'sent', ?, 'sending')
      `).bind(
        messageId,
        phoneId,
        phone.number,
        content,
        timestamp,
        recipient
      ).run();
      
      // Broadcast new message event
      const messageData = {
        id: messageId,
        phone_iccid: phoneId,
        phone_number: phone.number,
        content,
        timestamp,
        type: 'sent',
        recipient,
        status: 'sending'
      };
      await broadcastEvent(env, 'message:created', messageData);
      
      // Send SMS request to daemon via WebSocket
      const roomId = env.WEBSOCKET_ROOMS.idFromName('global');
      const room = env.WEBSOCKET_ROOMS.get(roomId);
      
      // Forward message to daemon
      await room.fetch('http://internal/forward-to-daemon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'send_message',
          data: {
            message_id: messageId,
            phone_iccid: phoneId,
            recipient: recipient,
            content: content
          }
        })
      });
      
      return new Response(JSON.stringify({
        success: true,
        data: {
          id: messageId,
          phoneId,
          recipient,
          content,
          timestamp,
          type: 'sent',
          status: 'pending'
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Error handling - send message
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to send message'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};