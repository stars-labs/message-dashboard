import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { VISIBLE_FILTER_STATUSES } from '../utils/spam-filter.js';
import { normalizeRecipient } from '../utils/recipient.js';

const D1_MAX_BOUND_PARAMETERS = 100;

async function enrichMessagePage(db, messages) {
  const iccids = [...new Set(messages.map((message) => message.phone_iccid).filter(Boolean))];
  const devicesByIccid = new Map();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db.prepare(`
      SELECT iccid, number, carrier, sim_status, sim_index, country
      FROM device_view
      WHERE iccid IN (${placeholders})
    `).bind(...chunk).all();
    const devices = result.results || result;
    for (const device of devices) devicesByIccid.set(device.iccid, device);
  }

  return messages.map((message) => {
    const device = devicesByIccid.get(message.phone_iccid);
    return {
      ...message,
      display_phone_number: device?.number || message.phone_number,
      phone_carrier: device?.carrier ?? null,
      phone_status: device?.sim_status ?? null,
      phone_sim_index: device?.sim_index ?? null,
      phone_country: device?.country ?? null,
      mapped_number: null,
    };
  });
}

export const messagesHandler = {
  // List messages with pagination
  async list(request) {
    const { env } = request;
    const url = new URL(request.url);
    const phoneIccid = url.searchParams.get('phone_iccid');
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
    const requestedOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    const since = url.searchParams.get('since');
    const isIncremental = since !== null;
    const serverTime = new Date().toISOString();
    const requestedUntil = url.searchParams.get('until');
    const beforeCreatedAt = url.searchParams.get('before_created_at');
    const beforeId = url.searchParams.get('before_id');
    // Spam/marketing messages are hidden unless explicitly asked for.
    const includeFiltered = url.searchParams.get('include_filtered') === '1';

    console.log('[Messages Handler] List request:', {
      phoneIccid,
      limit,
      offset,
      since,
      includeFiltered,
      url: url.toString()
    });

    try {
      // Carrier maintenance traffic is retained for its own audit workflow and
      // must never appear in either the normal inbox or the spam drawer.
      const conditions = [`m.purpose = 'user'`];
      const scopeParams = [];

      if (phoneIccid) {
        conditions.push(`m.phone_iccid = ?`);
        scopeParams.push(phoneIccid);
      }

      const listConditions = [...conditions];
      const listParams = [...scopeParams];

      if (isIncremental) {
        if (Number.isNaN(Date.parse(since))) {
          return Response.json({ success: false, error: 'Invalid since timestamp' }, { status: 400 });
        }
        if (requestedOffset !== 0) {
          return Response.json({ success: false, error: 'Incremental sync uses a keyset cursor, not offset' }, { status: 400 });
        }
        if (requestedUntil && Number.isNaN(Date.parse(requestedUntil))) {
          return Response.json({ success: false, error: 'Invalid until timestamp' }, { status: 400 });
        }
        if ((beforeCreatedAt === null) !== (beforeId === null)
            || (beforeCreatedAt && Number.isNaN(Date.parse(beforeCreatedAt)))) {
          return Response.json({ success: false, error: 'Invalid incremental page cursor' }, { status: 400 });
        }
        const syncUntil = requestedUntil || serverTime;
        // created_at is the ingestion clock. Message timestamps come from modems and
        // may be delayed, so they cannot safely serve as an incremental cursor.
        // A small overlap protects the boundary; the client deduplicates by ID.
        listConditions.push(`m.created_at >= datetime(?, '-2 seconds')`);
        listConditions.push(`m.created_at <= datetime(?)`);
        listParams.push(since, syncUntil);
        if (beforeCreatedAt && beforeId) {
          listConditions.push(`(m.created_at < ? OR (m.created_at = ? AND m.id < ?))`);
          listParams.push(beforeCreatedAt, beforeCreatedAt, beforeId);
        }
      }

      if (!includeFiltered) {
        const placeholders = VISIBLE_FILTER_STATUSES.map(() => '?').join(', ');
        listConditions.push(`m.filter_status IN (${placeholders})`);
        listParams.push(...VISIBLE_FILTER_STATUSES);
      }

      const listWhere = listConditions.length ? `WHERE ${listConditions.join(' AND ')}` : '';
      const orderBy = isIncremental
        ? 'm.created_at DESC, m.id DESC'
        : 'm.timestamp DESC, m.id DESC';
      const query = `
        SELECT m.*
        FROM messages m
        ${listWhere}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `;
      // Fetch one extra row to answer "is there another page?" without an
      // unbounded COUNT/SUM over message history.
      listParams.push(limit + 1, offset);

      const messagesResult = await env.DB.prepare(query).bind(...listParams).all();
      const rawMessages = messagesResult.results || messagesResult;
      const hasMore = rawMessages.length > limit;
      const pageRows = rawMessages.slice(0, limit);
      const messages = await enrichMessagePage(env.DB, pageRows);
      const lastPageRow = pageRows.at(-1);

      console.log('[Messages Handler] Query results:', {
        phoneIccid,
        count: messages.length,
        hasMore,
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

      const pagination = {
        include_filtered: includeFiltered,
        limit,
        offset,
        has_more: hasMore,
        next_offset: !isIncremental && hasMore ? offset + limit : null,
        next_cursor: isIncremental && hasMore && lastPageRow
          ? { created_at: lastPageRow.created_at, id: lastPageRow.id }
          : null,
      };

      return new Response(JSON.stringify({
        success: true,
        data: messages,
        pagination,
        sync: {
          server_time: isIncremental ? (requestedUntil || serverTime) : serverTime,
          is_incremental: isIncremental,
        },
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
