import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { FILTER_STATUS, VISIBLE_FILTER_STATUSES } from '../utils/spam-filter.js';
import { normalizeRecipient } from '../utils/recipient.js';

export const messagesHandler = {
  // List messages with pagination
  async list(request) {
    const { env } = request;
    const url = new URL(request.url);
    const phoneIccid = url.searchParams.get('phone_iccid');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    // Spam/marketing messages are hidden unless explicitly asked for.
    const includeFiltered = url.searchParams.get('include_filtered') === '1';

    console.log('[Messages Handler] List request:', {
      phoneIccid,
      limit,
      offset,
      includeFiltered,
      url: url.toString()
    });

    try {
      // Built once and shared by both queries so they can never disagree about
      // which rows they are talking about. Each query keeps its OWN bind array.
      const conditions = [];
      const scopeParams = [];

      if (phoneIccid) {
        conditions.push(`phone_iccid = ?`);
        scopeParams.push(phoneIccid);
      }

      const listConditions = [...conditions];
      const listParams = [...scopeParams];

      if (!includeFiltered) {
        const placeholders = VISIBLE_FILTER_STATUSES.map(() => '?').join(', ');
        listConditions.push(`filter_status IN (${placeholders})`);
        listParams.push(...VISIBLE_FILTER_STATUSES);
      }

      const listWhere = listConditions.length ? `WHERE ${listConditions.map(c => `m.${c}`).join(' AND ')}` : '';
      const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const query = `
        SELECT
          m.*,
          COALESCE(dv.number, m.phone_number) as display_phone_number,
          dv.carrier as phone_carrier,
          dv.sim_status as phone_status,
          dv.sim_index as phone_sim_index,
          NULL as mapped_number
        FROM messages m
        LEFT JOIN device_view dv ON m.phone_iccid = dv.iccid
        ${listWhere}
        ORDER BY m.timestamp DESC
        LIMIT ? OFFSET ?
      `;
      listParams.push(limit, offset);

      // One aggregate gives both counts, so the "已过滤 N 条" badge costs no extra
      // round trip. FILTER_STATUS.FILTERED is a module constant, not user input.
      const countQuery = `
        SELECT
          COALESCE(SUM(CASE WHEN filter_status =  '${FILTER_STATUS.FILTERED}' THEN 1 ELSE 0 END), 0) AS filtered,
          COALESCE(SUM(CASE WHEN filter_status <> '${FILTER_STATUS.FILTERED}' THEN 1 ELSE 0 END), 0) AS visible
        FROM messages
        ${countWhere}
      `;

      const [messagesResult, count] = await Promise.all([
        env.DB.prepare(query).bind(...listParams).all(),
        env.DB.prepare(countQuery).bind(...scopeParams).first()
      ]);

      const messages = messagesResult.results || messagesResult;
      const total = includeFiltered ? count.visible + count.filtered : count.visible;

      console.log('[Messages Handler] Query results:', {
        phoneIccid,
        count: messages.length,
        totalCount: total,
        filteredCount: count.filtered,
      });
      
      // DEBUG: Verify all messages have the correct ICCID when filtered
      if (phoneIccid) {
        const wrongIccidMessages = messages.filter(msg => msg.phone_iccid !== phoneIccid);
        if (wrongIccidMessages.length > 0) {
          console.error('[Messages Handler] ERROR: Query returned messages with wrong ICCIDs!');
          console.error('Query filter ICCID:', phoneIccid);
          console.error('Wrong ICCID messages found:', wrongIccidMessages.length);
          console.error('Sample wrong messages:', wrongIccidMessages.slice(0, 3).map(m => ({
            id: m.id,
            phone_iccid: m.phone_iccid,
            content: m.content?.substring(0, 30) + '...'
          })));
        } else {
          console.log('[Messages Handler] ✓ All messages have correct ICCID:', phoneIccid);
        }
      }

      return new Response(JSON.stringify({
        success: true,
        data: messages,
        pagination: {
          total,
          filtered_count: count.filtered,
          include_filtered: includeFiltered,
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
      const { phone_iccid, content } = body;

      // Validate input
      if (!phone_iccid || !body.recipient || !content) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields: phone_iccid, recipient, and content are required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // The recipient ends up inside an `AT+CMGS="..."` command on the daemon, where a
      // CR would terminate the command and let the rest execute as AT commands. Only
      // E.164 gets past here, and the NORMALISED value is what we store — never
      // body.recipient. See docs/SECURITY-REVIEW.md finding 3.
      const recipientCheck = normalizeRecipient(body.recipient);

      if (!recipientCheck.ok) {
        return new Response(JSON.stringify({
          success: false,
          error: `Invalid recipient: ${recipientCheck.reason}`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const recipient = recipientCheck.value;


      // Get phone details - check for active statuses
      const phone = await env.DB.prepare(`
        SELECT * FROM device_view WHERE iccid = ? AND sim_status = 'active'
      `).bind(phone_iccid).first();


      if (!phone) {
        // Check if phone exists with any status
        const anyPhone = await env.DB.prepare(`
          SELECT iccid, sim_status FROM device_view WHERE iccid = ?
        `).bind(phone_iccid).first();
        
        if (anyPhone) {
          return new Response(JSON.stringify({
            success: false,
            error: `Phone found but status is '${anyPhone.sim_status}' (not active)`
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