import { ORPCError } from '@orpc/server';
import { nanoid } from 'nanoid';
import * as v from 'valibot';
import { VISIBLE_FILTER_STATUSES } from '../utils/spam-filter.js';
import { normalizeRecipient } from '../utils/recipient.js';
import type {
  MessagePage,
  MessagesQuery,
  SendMessageBody,
  SendMessageResponse,
} from '../../shared/api/messages.js';
import { D1_MAX_BOUND_PARAMETERS, type D1 } from '../lib/d1.js';
import {
  findActiveDeviceNumber,
  findDeviceStatus,
  insertSentMessage,
  listDeviceSummaries,
  listMessages,
  listOutboundStatusChanges,
  type DeviceSummary,
  type MessageRow,
} from '../db/messages.js';

const OUTBOUND_REFRESH_LIMIT = 50;

interface ListCall {
  env: { DB: D1<'all'> };
}

interface SendCall {
  env: { DB: D1<'first' | 'run'> };
}

async function enrichMessagePage(db: D1<'all'>, messages: MessageRow[]) {
  const iccids = [
    ...new Set(
      messages
        .map((message) => message.phone_iccid)
        .filter((iccid): iccid is string => iccid !== null && iccid !== ''),
    ),
  ];
  const devicesByIccid = new Map<string, DeviceSummary>();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const devices = await listDeviceSummaries(db, chunk);
    for (const device of devices) devicesByIccid.set(device.iccid, device);
  }

  return messages.map((message) => {
    const device = message.phone_iccid ? devicesByIccid.get(message.phone_iccid) : undefined;
    return {
      ...message,
      display_phone_number:
        device !== undefined && device.number !== '' ? device.number : message.phone_number,
      phone_carrier: device?.carrier ?? null,
      phone_status: device?.sim_status ?? null,
      phone_sim_index: device?.sim_index ?? null,
      phone_country: device?.country ?? null,
      mapped_number: null,
    };
  });
}

function badRequest(message: string): ORPCError<'BAD_REQUEST', unknown> {
  return new ORPCError('BAD_REQUEST', { message });
}

export const messagesHandler = {
  async list({ env }: ListCall, query: v.InferOutput<typeof MessagesQuery>): Promise<MessagePage> {
    const phoneIccid = query.phone_iccid ?? null;
    const requestedLimit = Number.parseInt(query.limit ?? '50', 10);
    const requestedOffset = Number.parseInt(query.offset ?? '0', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    const since = query.since ?? null;
    const isIncremental = since !== null;
    const serverTime = new Date().toISOString();
    const requestedUntil = query.until ?? null;
    const syncUntil =
      requestedUntil === null || requestedUntil === '' ? serverTime : requestedUntil;
    const beforeCreatedAt = query.before_created_at ?? null;
    const beforeId = query.before_id ?? null;
    const includeFiltered = query.include_filtered === '1';

    try {
      // Carrier maintenance traffic (purpose != 'user') never appears in the inbox or the spam drawer.
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
          throw badRequest('Invalid since timestamp');
        }
        if (requestedOffset !== 0) {
          throw badRequest('Incremental sync uses a keyset cursor, not offset');
        }
        if (requestedUntil && Number.isNaN(Date.parse(requestedUntil))) {
          throw badRequest('Invalid until timestamp');
        }
        if (
          (beforeCreatedAt === null) !== (beforeId === null) ||
          (beforeCreatedAt && Number.isNaN(Date.parse(beforeCreatedAt)))
        ) {
          throw badRequest('Invalid incremental page cursor');
        }
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

      const orderBy = isIncremental
        ? 'm.created_at DESC, m.id DESC'
        : 'm.timestamp DESC, m.id DESC';
      // One extra row answers "is there another page?" without a COUNT over message history.
      listParams.push(limit + 1, offset);

      const rawMessages = await listMessages(env.DB, {
        conditions: listConditions,
        params: listParams,
        orderBy,
      });
      const hasMore = rawMessages.length > limit;
      const pageRows = rawMessages.slice(0, limit);
      const lastPageRow = pageRows.at(-1);

      // An outbound row is written once and its status moves later, so paging on
      // created_at alone would never deliver the final status. Also fetch outbound
      // rows whose updated_at moved inside this window but are too old for the page above.
      const refreshRows = isIncremental
        ? await listOutboundStatusChanges(env.DB, {
            since,
            until: syncUntil,
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
        next_cursor:
          isIncremental && hasMore && lastPageRow
            ? { created_at: lastPageRow.created_at, id: lastPageRow.id }
            : null,
      };

      return {
        success: true,
        data: messages,
        pagination,
        sync: {
          server_time: isIncremental ? syncUntil : serverTime,
          is_incremental: isIncremental,
          status_refreshed: extraRows.length,
        },
      };
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      console.error('[messages] list failed:', error);
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Failed to fetch messages' });
    }
  },

  async send(
    { env }: SendCall,
    body: v.InferOutput<typeof SendMessageBody>,
  ): Promise<SendMessageResponse> {
    // The recipient ends up inside an `AT+CMGS="..."` command on the daemon, where a
    // CR would let the rest execute as AT commands. Store the normalised value,
    // never body.recipient (docs/SECURITY-REVIEW.md finding 3).
    const { phone_iccid: phoneIccid, content } = body;
    const recipientCheck = normalizeRecipient(body.recipient);
    if (!recipientCheck.ok) throw badRequest(`Invalid recipient: ${recipientCheck.reason}`);
    const recipient = recipientCheck.value;

    try {
      const phone = await findActiveDeviceNumber(env.DB, phoneIccid);

      if (!phone) {
        const anyPhone = await findDeviceStatus(env.DB, phoneIccid);

        throw badRequest(
          anyPhone
            ? `Phone found but status is '${anyPhone.sim_status}' (not active)`
            : `Phone with ICCID '${phoneIccid}' not found in database`,
        );
      }

      const messageId = `msg-sent-${nanoid()}`;
      const timestamp = new Date().toISOString();

      await insertSentMessage(env.DB, {
        id: messageId,
        phoneIccid,
        phoneNumber: phone.number,
        content,
        timestamp,
        recipient,
      });

      // The daemon polls /api/control/pending-sms and sends the message.

      return {
        success: true,
        messageId,
        data: {
          id: messageId,
          phone_iccid: phoneIccid,
          recipient,
          content,
          timestamp,
          type: 'sent',
          status: 'pending',
        },
      };
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      console.error('[messages] send failed:', error);
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Failed to send message' });
    }
  },
};
