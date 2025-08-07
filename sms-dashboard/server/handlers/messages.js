import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';

export const messagesHandler = {
  // List messages with pagination
  async list(request) {
    const { env } = request;
    const url = new URL(request.url);
    const phoneIccid = url.searchParams.get('phone_iccid');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    
    console.log('[Messages Handler] List request:', {
      phoneIccid,
      limit,
      offset,
      url: url.toString()
    });

    try {
      let query = `
        SELECT 
          m.*,
          COALESCE(im.phone_number, p.number, m.phone_number) as display_phone_number,
          p.carrier as phone_carrier,
          p.status as phone_status,
          im.phone_number as mapped_number
        FROM messages m
        LEFT JOIN phones p ON m.phone_iccid = p.iccid
        LEFT JOIN iccid_mappings im ON m.phone_iccid = im.iccid AND im.is_active = 1
      `;
      let countQuery = `SELECT COUNT(*) as total FROM messages`;
      const params = [];

      if (phoneIccid) {
        query += ` WHERE m.phone_iccid = ?`;
        countQuery += ` WHERE phone_iccid = ?`;
        params.push(phoneIccid);
      }

      query += ` ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const [messagesResult, count] = await Promise.all([
        env.DB.prepare(query).bind(...params).all(),
        env.DB.prepare(countQuery).bind(...(phoneIccid ? [phoneIccid] : [])).first()
      ]);
      
      const messages = messagesResult.results || messagesResult;
      console.log('[Messages Handler] Query results:', {
        phoneIccid,
        messageCount: messages.length,
        totalCount: count.total,
        firstMessage: messages[0] ? {
          id: messages[0].id,
          phone_iccid: messages[0].phone_iccid,
          content: messages[0].content?.substring(0, 50) + '...'
        } : null
      });

      return new Response(JSON.stringify({
        success: true,
        data: messages,
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
      const { phone_iccid, recipient, content } = body;
      
      // Validate input
      if (!phone_iccid || !recipient || !content) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields: phone_iccid, recipient, and content are required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      

      // Get phone details - check for active statuses
      const phone = await env.DB.prepare(`
        SELECT * FROM phones WHERE iccid = ? AND status IN ('registered', 'active', 'online')
      `).bind(phone_iccid).first();


      if (!phone) {
        // Check if phone exists with any status
        const anyPhone = await env.DB.prepare(`
          SELECT iccid, status FROM phones WHERE iccid = ?
        `).bind(phone_iccid).first();
        
        if (anyPhone) {
          return new Response(JSON.stringify({
            success: false,
            error: `Phone found but status is '${anyPhone.status}' (not active)`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          return new Response(JSON.stringify({
            success: false,
            error: `Phone with ICCID '${phone_iccid}' not found in database`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Create message record - simple and clean
      const messageId = `msg-sent-${nanoid()}`;
      const timestamp = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, recipient, status)
        VALUES (?, ?, ?, ?, ?, 'sent', ?, 'sending')
      `).bind(
        messageId,
        phone_iccid,
        phone.number,
        content,
        timestamp,
        recipient
      ).run();

      // Broadcast new message event
      const messageData = {
        id: messageId,
        phone_iccid: phone_iccid,
        phone_number: phone.number,
        content,
        timestamp,
        type: 'sent',
        recipient,
        status: 'sending'
      };
      // Message creation is now picked up by polling

      // Note: SMS sending is now handled by daemon polling /api/control/pending-sms
      // The daemon will pick up this message and send it via real SMS network

      return new Response(JSON.stringify({
        success: true,
        messageId: messageId,  // Add messageId at top level for WebSocket handler
        data: {
          id: messageId,
          phone_iccid: phone_iccid,
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