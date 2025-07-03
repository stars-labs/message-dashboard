import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';

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
        query += ` WHERE phone_id = ?`;
        countQuery += ` WHERE phone_id = ?`;
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
      console.error('List messages error:', error);
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
      console.error('Get message error:', error);
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
        SELECT * FROM phones WHERE id = ? AND status = 'online'
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
        INSERT INTO messages (id, phone_id, phone_number, content, timestamp, type, recipient, status)
        VALUES (?, ?, ?, ?, ?, 'sent', ?, 'pending')
      `).bind(
        messageId,
        phoneId,
        phone.number,
        content,
        timestamp,
        recipient
      ).run();
      
      // TODO: Implement actual SMS sending logic here
      // For now, we'll simulate success
      setTimeout(async () => {
        await env.DB.prepare(`
          UPDATE messages SET status = 'delivered' WHERE id = ?
        `).bind(messageId).run();
      }, 2000);
      
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
      console.error('Send message error:', error);
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