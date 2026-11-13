import { nanoid } from 'nanoid';
import { VISIBLE_FILTER_STATUSES } from '../utils/spam-filter.js';
import { normalizeRecipient } from '../utils/recipient.js';
import type { AppRequest } from '../worker-context.js';
import type { D1Database } from '../cf-bindings.js';

const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * How many outbound status changes one incremental response carries. Sending is
 * operator-driven and rare next to inbound traffic, so this is generous.
 */
const OUTBOUND_REFRESH_LIMIT = 50;

/** A messages row. Untyped columns stay `unknown` rather than pretending to a shape. */
interface MessageRow {
  id: string;
  phone_iccid: string | null;
  phone_number: string | null;
  content: string | null;
  created_at: string | null;
  [column: string]: unknown;
}

/** The device_view columns enrichMessagePage joins onto each message. */
interface DeviceSummary {
  iccid: string;
  number: string | null;
  carrier: string | null;
  sim_status: string | null;
  sim_index: number | null;
  country: string | null;
}

/**
 * Outbound rows whose status moved inside the sync window. Scoped to `sent`
 * rows and ordered by the indexed `updated_at` (migration 079), so it cannot
 * turn into a scan of message history.
 */
async function outboundStatusChanges(
  db: D1Database,
  { since, until, phoneIccid, limit }: {
    since: string;
    until: string;
    phoneIccid: string | null;
    limit: number;
  },
): Promise<MessageRow[]> {
  const conditions = [
    `m.purpose = 'user'`,
    `m.type = 'sent'`,
    `m.updated_at IS NOT NULL`,
    `m.updated_at >= datetime(?, '-2 seconds')`,
    `m.updated_at <= datetime(?)`,
  ];
  const params: unknown[] = [since, until];
  if (phoneIccid) {
    conditions.push(`m.phone_iccid = ?`);
    params.push(phoneIccid);
  }
  params.push(limit);

  const result = await db.prepare(`
    SELECT m.*
    FROM messages m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.updated_at DESC
    LIMIT ?
  `).bind(...params).all<MessageRow>();
  return result.results || [];
}

async function enrichMessagePage(db: D1Database, messages: MessageRow[]) {
  const iccids = [...new Set(messages.map((message) => message.phone_iccid).filter(Boolean))];
  const devicesByIccid = new Map<string, DeviceSummary>();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db.prepare(`
      SELECT iccid, number, carrier, sim_status, sim_index, country
      FROM device_view
      WHERE iccid IN (${placeholders})
    `).bind(...chunk).all<DeviceSummary>();
    for (const device of result.results) devicesByIccid.set(device.iccid, device);
  }

  return messages.map((message) => {
    const device = message.phone_iccid ? devicesByIccid.get(message.phone_iccid) : undefined;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Request body of POST /api/messages/send, before validation. */
interface SendBody {
  phone_iccid?: unknown;
  recipient?: unknown;
  content?: unknown;
}

export const messagesHandler = {
  // List messages with pagination
  async list(request: AppRequest): Promise<Response> {
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

    try {
      // Carrier maintenance traffic is retained for its own audit workflow and
      // must never appear in either the normal inbox or the spam drawer.
      const conditions = [`m.purpose = 'user'`];
      const scopeParams: unknown[] = [];

      if (phoneIccid) {
        conditions.push(`m.phone_iccid = ?`);
        scopeParams.push(phoneIccid);
      }

      const listConditions = [...conditions];
      const listParams: unknown[] = [...scopeParams];

      if (isIncremental) {
        if (Number.isNaN(Date.parse(since))) {
          return json({ success: false, error: 'Invalid since timestamp' }, 400);
        }
        if (requestedOffset !== 0) {
          return json({ success: false, error: 'Incremental sync uses a keyset cursor, not offset' }, 400);
        }
        if (requestedUntil && Number.isNaN(Date.parse(requestedUntil))) {
          return json({ success: false, error: 'Invalid until timestamp' }, 400);
        }
        if ((beforeCreatedAt === null) !== (beforeId === null)
            || (beforeCreatedAt && Number.isNaN(Date.parse(beforeCreatedAt)))) {
          return json({ success: false, error: 'Invalid incremental page cursor' }, 400);
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

      const messagesResult = await env.DB.prepare(query).bind(...listParams).all<MessageRow>();
      const rawMessages = messagesResult.results;
      const hasMore = rawMessages.length > limit;
      const pageRows = rawMessages.slice(0, limit);
      const lastPageRow = pageRows.at(-1);

      // An outbound row is written once and its status moves later, so paging on
      // created_at alone never delivered 已发送 or 发送失败 — the dashboard sat on
      // 等待发送 forever. Ask separately for outbound rows whose updated_at moved
      // inside this window but which are too old for the page above. Outbound
      // volume is low and the window is the poll interval, so this stays small.
      const refreshRows = isIncremental && since
        ? await outboundStatusChanges(env.DB, {
            since,
            until: requestedUntil || serverTime,
            phoneIccid,
            limit: OUTBOUND_REFRESH_LIMIT,
          })
        : [];
      const seenIds = new Set(pageRows.map((row) => row.id));
      const extraRows = refreshRows.filter((row) => !seenIds.has(row.id));
      const messages = await enrichMessagePage(env.DB, [...pageRows, ...extraRows]);

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

      return json({
        success: true,
        data: messages,
        pagination,
        sync: {
          server_time: isIncremental ? (requestedUntil || serverTime) : serverTime,
          is_incremental: isIncremental,
          // Rows already known to the client whose status changed.
          status_refreshed: extraRows.length,
        },
      });
    } catch {
      // Error handling - list messages
      return json({ success: false, error: 'Failed to fetch messages' }, 500);
    }
  },

  // Get specific message
  async get(request: AppRequest): Promise<Response> {
    const { env } = request;
    const messageId = request.params?.id;

    try {
      const message = await env.DB.prepare(`
        SELECT * FROM messages WHERE id = ?
      `).bind(messageId).first<MessageRow>();

      if (!message) {
        return json({ success: false, error: 'Message not found' }, 404);
      }

      return json({ success: true, data: message });
    } catch {
      // Error handling - get message
      return json({ success: false, error: 'Failed to fetch message' }, 500);
    }
  },

  // Send SMS
  async send(request: AppRequest): Promise<Response> {
    const { env } = request;

    try {
      const body = (await request.json()) as SendBody;
      const { phone_iccid, content } = body;

      // Validate input
      if (!phone_iccid || !body.recipient || !content) {
        return json({
          success: false,
          error: 'Missing required fields: phone_iccid, recipient, and content are required',
        }, 400);
      }

      // The recipient ends up inside an `AT+CMGS="..."` command on the daemon, where a
      // CR would terminate the command and let the rest execute as AT commands. Only
      // E.164 gets past here, and the NORMALISED value is what we store — never
      // body.recipient. See docs/SECURITY-REVIEW.md finding 3.
      const recipientCheck = normalizeRecipient(body.recipient);

      if (!recipientCheck.ok) {
        return json({ success: false, error: `Invalid recipient: ${recipientCheck.reason}` }, 400);
      }

      const recipient = recipientCheck.value;
      const phoneIccid = String(phone_iccid);

      // Get phone details - check for active statuses
      const phone = await env.DB.prepare(`
        SELECT * FROM device_view WHERE iccid = ? AND sim_status = 'active'
      `).bind(phoneIccid).first<{ number: string | null }>();

      if (!phone) {
        // Check if phone exists with any status
        const anyPhone = await env.DB.prepare(`
          SELECT iccid, sim_status FROM device_view WHERE iccid = ?
        `).bind(phoneIccid).first<{ iccid: string; sim_status: string | null }>();

        if (anyPhone) {
          return json({
            success: false,
            error: `Phone found but status is '${anyPhone.sim_status}' (not active)`,
          }, 400);
        }
        return json({
          success: false,
          error: `Phone with ICCID '${phoneIccid}' not found in database`,
        }, 400);
      }

      // Create message record - simple and clean
      const messageId = `msg-sent-${nanoid()}`;
      const timestamp = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, recipient, status)
        VALUES (?, ?, ?, ?, ?, 'sent', ?, 'sending')
      `).bind(
        messageId,
        phoneIccid,
        phone.number,
        String(content),
        timestamp,
        recipient,
      ).run();

      // Note: SMS sending is now handled by daemon polling /api/control/pending-sms
      // The daemon will pick up this message and send it via real SMS network

      return json({
        success: true,
        messageId, // Add messageId at top level for WebSocket handler
        data: {
          id: messageId,
          phone_iccid: phoneIccid,
          recipient,
          content,
          timestamp,
          type: 'sent',
          status: 'pending',
        },
      });
    } catch {
      // Error handling - send message
      return json({ success: false, error: 'Failed to send message' }, 500);
    }
  },
};