import { extractVerificationCode } from '../utils/verification';
import { findKeywordMatches } from '../utils/keyword-match.js';
import { classifyMessage, loadActiveRules } from '../utils/spam-filter.js';
import { normalizeHealthSnapshot } from '../utils/daemon-health.js';
import {
  findPendingBalanceCheck,
  linkBalanceReply,
  mergeMultipartReplies,
  updateBalanceCheckForSmsResult,
} from './balance-queries.js';
import { processCarrierBillMessages } from '../utils/carrier-billing.js';
import type { BalanceCheckRow } from './balance-queries.js';

import type { AppRequest, Env } from '../worker-context.js';
import type { D1Database } from '../cf-bindings.js';

/** One entry of the daemon's modem_reports array. Fields the worker reads or stores. */
interface ModemReport {
  equipment_id: string;
  manufacturer?: string | null;
  model?: string | null;
  firmware_revision?: string | null;
  hardware_revision?: string | null;
  detected_iccid?: string | null;
  detected_phone_number?: string | null;
  detected_operator?: string | null;
  signal_percent?: number | null;
  rssi?: number | null;
  modem_index?: number | null;
  usb_port?: number | null;
  usb_path?: string | null;
  last_usb_path?: string | null;
  status?: string | null;
  [field: string]: unknown;
}

/** POST /api/control/devices body. */
interface DevicesBody {
  modem_reports?: unknown;
  removed_equipment_ids?: unknown;
  sync_mode?: unknown;
  session_id?: unknown;
}

/** One SMS as uploaded by the daemon. */
interface UploadedMessage {
  id?: unknown;
  phone_iccid?: unknown;
  phone_number?: unknown;
  content?: unknown;
  timestamp?: unknown;
}

/** A stored, normalized message, before classification side effects. */
interface StoredMessage {
  id: string;
  phone_iccid: string;
  phone_number: string | null;
  content: string;
  timestamp: string;
  type: 'received';
  verification_code: string | null;
  purpose: 'user' | 'balance_maintenance';
  balance_check_id: string | null;
}

/** The three send outcomes the daemon reports. */
type SmsOutcome = 'confirmed' | 'submitted_unconfirmed' | 'failed';

const SMS_STATUS_FOR_OUTCOME: Record<SmsOutcome, string> = {
  confirmed: 'sent',
  submitted_unconfirmed: 'unknown',
  failed: 'failed',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Every control route authenticates with the daemon's shared API key, never
 * Auth0. Returns a Response when the key is wrong.
 */
function requireApiKey(request: AppRequest, env: Env): Response | null {
  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey || apiKey !== env.API_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

const DAEMON_SESSION_ID = /^[A-Za-z0-9._:-]{1,120}$/;

export function normalizeDaemonSessionId(value: unknown): string | null {
  return typeof value === 'string' && DAEMON_SESSION_ID.test(value) ? value : null;
}

export const controlHandler = {
  // Synchronize the daemon's canonical modem reports without rewriting unchanged rows.
  async updateDevices(request: AppRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = requireApiKey(request, env);
    if (unauthorized) return unauthorized;

    // Parse request body
    const body = (await request.json()) as DevicesBody;
    const reports = body.modem_reports;
    const removedEquipmentIds = body.removed_equipment_ids;
    const sync_mode = body.sync_mode ?? 'incremental';
    const session_id = body.session_id ?? null;
    if (!Array.isArray(reports) || !Array.isArray(removedEquipmentIds)) {
      return new Response(
        JSON.stringify({
          error: 'modem_reports and removed_equipment_ids must be arrays',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (
      (sync_mode !== 'incremental' && sync_mode !== 'full') ||
      (sync_mode === 'full' && !session_id)
    ) {
      return new Response(
        JSON.stringify({ error: 'Invalid sync mode or missing full-sync session ID' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    try {
      console.log(
        `[control.js] Received ${reports.length} modem_reports (mode: ${sync_mode}, session: ${session_id})`,
      );

      const acceptedReports = (reports as ModemReport[]).filter((report): report is ModemReport => {
        if (!report?.equipment_id) return false;
        return !(report.equipment_id.startsWith('MODEM_') && !report.manufacturer && !report.model);
      });
      const removedIds = [...new Set(removedEquipmentIds as string[])];
      if (
        removedIds.some((id) => typeof id !== 'string' || !id) ||
        acceptedReports.some((report) => removedIds.includes(report.equipment_id))
      ) {
        return new Response(
          JSON.stringify({ error: 'Invalid or conflicting removed equipment IDs' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const verificationStatus = sync_mode === 'full' ? 'verified' : null;
      const lastVerifiedSession = sync_mode === 'full' ? session_id : null;

      const statements = acceptedReports.map((report) =>
        env.DB.prepare(
          `
        INSERT INTO modems (
          equipment_id, manufacturer, model, firmware_revision,
          hardware_revision, detected_iccid, detected_phone_number,
          detected_operator, signal_percent, rssi,
          modem_index, usb_port, usb_path, last_usb_path, status,
          verification_status, last_verified_session, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(equipment_id) DO UPDATE SET
          manufacturer = excluded.manufacturer,
          model = excluded.model,
          firmware_revision = excluded.firmware_revision,
          hardware_revision = excluded.hardware_revision,
          detected_iccid = excluded.detected_iccid,
          detected_phone_number = excluded.detected_phone_number,
          detected_operator = excluded.detected_operator,
          signal_percent = excluded.signal_percent,
          rssi = excluded.rssi,
          modem_index = excluded.modem_index,
          usb_port = excluded.usb_port,
          usb_path = excluded.usb_path,
          last_usb_path = COALESCE(excluded.last_usb_path, modems.last_usb_path),
          status = excluded.status,
          verification_status = COALESCE(excluded.verification_status, modems.verification_status),
          last_verified_session = COALESCE(excluded.last_verified_session, modems.last_verified_session),
          updated_at = CURRENT_TIMESTAMP
        WHERE modems.manufacturer IS NOT excluded.manufacturer
          OR modems.model IS NOT excluded.model
          OR modems.firmware_revision IS NOT excluded.firmware_revision
          OR modems.hardware_revision IS NOT excluded.hardware_revision
          OR modems.detected_iccid IS NOT excluded.detected_iccid
          OR modems.detected_phone_number IS NOT excluded.detected_phone_number
          OR modems.detected_operator IS NOT excluded.detected_operator
          OR modems.modem_index IS NOT excluded.modem_index
          OR modems.usb_port IS NOT excluded.usb_port
          OR modems.usb_path IS NOT excluded.usb_path
          OR modems.last_usb_path IS NOT COALESCE(excluded.last_usb_path, modems.last_usb_path)
          OR modems.status IS NOT excluded.status
          OR (excluded.verification_status IS NOT NULL
              AND modems.verification_status IS NOT excluded.verification_status)
          OR (excluded.last_verified_session IS NOT NULL
              AND modems.last_verified_session IS NOT excluded.last_verified_session)
          OR modems.signal_percent IS NOT excluded.signal_percent
          OR modems.rssi IS NOT excluded.rssi
      `,
        ).bind(
          report.equipment_id,
          report.manufacturer || null,
          report.model || null,
          report.firmware_revision || null,
          report.hardware_revision || null,
          report.detected_iccid || null,
          report.detected_phone_number || null,
          report.detected_operator || null,
          report.signal_percent ?? null,
          report.rssi ?? null,
          report.modem_index ?? null,
          report.usb_port ?? null,
          report.usb_path ?? null,
          report.usb_path ?? null,
          report.status || 'active',
          verificationStatus,
          lastVerifiedSession,
        ),
      );

      if (statements.length > 0) await env.DB.batch(statements);

      let explicitlyDisconnected = 0;
      if (removedIds.length > 0) {
        const placeholders = removedIds.map(() => '?').join(',');
        const result = await env.DB.prepare(
          `
          UPDATE modems
          SET status = 'disconnected',
              verification_status = 'absent',
              detected_iccid = NULL,
              detected_phone_number = NULL,
              detected_operator = NULL,
              signal_percent = NULL,
              rssi = NULL,
              usb_path = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE equipment_id IN (${placeholders})
            AND (
              status IS NOT 'disconnected'
              OR verification_status IS NOT 'absent'
              OR detected_iccid IS NOT NULL
              OR detected_phone_number IS NOT NULL
              OR detected_operator IS NOT NULL
              OR signal_percent IS NOT NULL
              OR rssi IS NOT NULL
              OR usb_path IS NOT NULL
            )
        `,
        )
          .bind(...removedIds)
          .run();
        explicitlyDisconnected = result.meta.changes;
      }

      let reconciledDisconnected = 0;
      if (sync_mode === 'full') {
        const presentEquipmentIds = JSON.stringify(
          acceptedReports.map((report) => report.equipment_id),
        );
        const disconnectResult = await env.DB.prepare(
          `
          UPDATE modems
          SET status = 'disconnected',
              verification_status = 'absent',
              detected_iccid = NULL,
              detected_phone_number = NULL,
              detected_operator = NULL,
              signal_percent = NULL,
              rssi = NULL,
              usb_path = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(?) AS present
            WHERE present.value = modems.equipment_id
          )
          AND (
            status IS NOT 'disconnected'
            OR verification_status IS NOT 'absent'
            OR detected_iccid IS NOT NULL
            OR detected_phone_number IS NOT NULL
            OR detected_operator IS NOT NULL
            OR signal_percent IS NOT NULL
            OR rssi IS NOT NULL
            OR usb_path IS NOT NULL
          )
        `,
        )
          .bind(presentEquipmentIds)
          .run();
        reconciledDisconnected = disconnectResult.meta.changes;
      }

      return new Response(
        JSON.stringify({
          success: true,
          sync_mode,
          session_id,
          processed: {
            modem_reports: acceptedReports.length,
            modems_disconnected: explicitlyDisconnected + reconciledDisconnected,
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('[control.js] Database error in updateDevices:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to update devices',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },

  // Upload messages from Orange Pi
  async uploadMessages(request: AppRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = requireApiKey(request, env);
    if (unauthorized) return unauthorized;

    try {
      const { messages } = (await request.json()) as { messages?: unknown };

      if (!Array.isArray(messages)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Messages must be an array',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      for (const message of messages as UploadedMessage[]) {
        if (!message?.id || typeof message.id !== 'string') {
          return new Response(
            JSON.stringify({
              success: false,
              error: 'Every message requires a daemon-assigned id',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        if (!message.phone_iccid || !message.content) {
          return new Response(
            JSON.stringify({
              success: false,
              error: 'Every message requires phone_iccid and content',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
      }

      let processed = 0;
      const results: Array<{ id: string; status: string; retryable?: boolean }> = [];
      const newMessages: StoredMessage[] = [];

      const insertStmt = env.DB.prepare(`
        INSERT INTO messages (
          id, phone_iccid, phone_number, content, timestamp, type,
          verification_code, status, created_at, updated_at,
          filter_status, filter_rule_id, purpose, balance_check_id
        )
        VALUES (
          ?, ?, ?, ?, ?, 'received', ?, 'received',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?
        ) ON CONFLICT(id) DO NOTHING
      `);

      // Spam rules are loaded ONCE per upload, not per message. Classification is
      // done inline rather than in ctx.waitUntil: the row must never be readable
      // while still 'pending', or marketing SMS would flash into the default list
      // in the window before a background task caught up.
      const filterRules = await loadActiveRules(env.DB);

      // Multi-part carrier replies arrive as separate messages sharing a sender and
      // timestamp, so group them before linking; otherwise the check closes on
      // whichever part is processed first.
      const multipartReplies = mergeMultipartReplies(messages as UploadedMessage[]);
      // Group key -> the check that claimed it, so later parts join that check.
      const claimedReplyGroups = new Map<string, BalanceCheckRow>();

      for (const msg of messages as UploadedMessage[]) {
        const messageId = String(msg.id);
        try {
          const phone_iccid = String(msg.phone_iccid);
          // Fix timestamp - handle various formatting issues
          let timestamp =
            typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString();

          // First handle URL-encoded + signs (convert to space temporarily for processing)
          timestamp = timestamp.replace(/\+/g, ' ');

          // Try to match timestamp with spaces or T separator
          const timeMatch = timestamp.match(
            /^(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{1,2}):(\d{1,2})(\.\d{3})?Z?$/,
          );
          if (timeMatch) {
            const [_, year, month, day, hours, minutes, seconds, millis] = timeMatch;
            timestamp = `${year}-${month}-${day}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}${millis || '.000'}Z`;
          } else {
            timestamp = timestamp.replace(/\s+/g, '');
            if (
              timestamp.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$/) &&
              !timestamp.endsWith('Z')
            ) {
              timestamp += 'Z';
            }
          }

          const phoneNumber = typeof msg.phone_number === 'string' ? msg.phone_number : null;
          const reply = multipartReplies.get(messageId);
          // A later part reuses its group's check rather than re-running the
          // pending lookup, which would find the same check and could queue a
          // duplicate follow-up for it.
          const groupClaim = reply ? (claimedReplyGroups.get(reply.key) ?? null) : null;
          // findPendingBalanceCheck returns null for a missing number anyway; pass ''
          // so the parameter is a string rather than relying on an untyped guard.
          const balanceCheck: BalanceCheckRow | null =
            groupClaim ||
            (await findPendingBalanceCheck(env.DB, {
              phone_iccid,
              phone_number: phoneNumber ?? '',
              message_timestamp: timestamp,
            }));
          const responseSender: string | null = phoneNumber;
          if (reply && !groupClaim && balanceCheck) {
            claimedReplyGroups.set(reply.key, balanceCheck);
          }
          const verificationCode = balanceCheck ? null : extractVerificationCode(msg.content);

          const record: StoredMessage = {
            id: messageId,
            phone_iccid,
            phone_number: phoneNumber,
            content: String(msg.content),
            timestamp,
            type: 'received',
            verification_code: verificationCode,
            purpose: balanceCheck ? 'balance_maintenance' : 'user',
            balance_check_id: balanceCheck?.id || null,
          };

          // Spam/marketing verdict. phone_number carries the SENDER's number for
          // received messages, which is what the sender rules match on.
          const verdict = balanceCheck
            ? { filter_status: 'filtered', filter_rule_id: null }
            : classifyMessage(record, filterRules);

          // D1's primary key is the sole idempotency boundary. No content/timestamp
          // comparison is valid here: two equal SMS payloads may be distinct SMS.
          const result = await insertStmt
            .bind(
              messageId,
              phone_iccid,
              phoneNumber,
              msg.content,
              timestamp,
              verificationCode,
              verdict.filter_status,
              verdict.filter_rule_id,
              record.purpose,
              record.balance_check_id,
            )
            .run();

          if (result.meta.changes === 0) {
            results.push({ id: messageId, status: 'already_stored' });
            continue;
          }

          processed += 1;
          results.push({ id: messageId, status: 'stored' });
          // Only a newly inserted message may trigger side effects, and a multi-part
          // reply triggers them once: the part that claimed the check decides it
          // using the whole merged text. Later parts are inserted already linked.
          if (balanceCheck) {
            if (!groupClaim) {
              await linkBalanceReply(
                env.DB,
                balanceCheck,
                { ...record, phone_number: responseSender },
                reply ? { mergedContent: reply.content } : {},
              );
            }
          } else newMessages.push(record);
        } catch (err) {
          // Per-message failure must not abort the batch. The daemon retries
          // transient errors; permanent input errors become dead_letter locally.
          const retryable = !(err instanceof TypeError);
          console.error(`[control.js] Message ${messageId} failed (retryable=${retryable}):`, err);
          results.push({ id: messageId, status: 'rejected', retryable });
        }
      }

      // Process new messages with AI and keywords (async, don't wait)
      if (newMessages.length > 0) {
        // Process messages in the background
        request.ctx.waitUntil(
          Promise.all([
            Promise.all(
              newMessages.map(async (msg) => {
                try {
                  await processMessageKeywords(env.DB, msg);
                } catch (error) {
                  console.error(`Message processing error for message ${msg.id}:`, error);
                }
              }),
            ),
            processCarrierBillMessages(
              env.DB,
              newMessages as unknown as Array<Partial<{ id: string }>>,
            ),
          ]),
        );
      }

      // Messages are now picked up by polling

      return new Response(
        JSON.stringify({
          success: true,
          processed,
          results,
          message: `Successfully uploaded ${processed} messages`,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('[control.js] Upload messages error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to upload messages: ' + (error as Error).message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },
  // Cleanup test data
  async cleanupTestData(request: AppRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = requireApiKey(request, env);
    if (unauthorized) return unauthorized;

    try {
      const { phoneIds } = (await request.json()) as { phoneIds?: unknown };

      if (!Array.isArray(phoneIds)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'phoneIds must be an array',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      // Delete test SIMs by ICCID
      const placeholders = (phoneIds as string[]).map(() => '?').join(',');
      const deleteStmt = env.DB.prepare(`DELETE FROM sims WHERE iccid IN (${placeholders})`);

      const result = await deleteStmt.bind(...(phoneIds as string[])).run();

      // Also delete any SIMs without ICCID
      const cleanupNullIccid = await env.DB.prepare(
        `DELETE FROM sims WHERE iccid IS NULL OR iccid = ''`,
      ).run();

      return new Response(
        JSON.stringify({
          success: true,
          deleted: result.meta.changes,
          cleanedNullIccid: cleanupNullIccid.meta.changes,
          message: `Deleted ${result.meta.changes} test SIMs and ${cleanupNullIccid.meta.changes} SIMs without ICCID`,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('Cleanup error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to cleanup test data',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },

  // Poll and claim pending SMS. Process health has one separate authoritative writer.
  //
  // SMS Status Flow:
  //   'sending' (created by user)
  //   → 'processing' (atomically set when daemon fetches)
  //   → 'sent'/'failed' (reported by daemon after modem response)
  //
  // The atomic transition to 'processing' prevents duplicate sends in the race condition
  // where daemon polls again before the SMS send completes and status is updated to 'sent'.
  async getPendingSMS(request: AppRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = requireApiKey(request, env);
    if (unauthorized) return unauthorized;

    try {
      const rawDaemonSessionId = request.headers.get('X-Daemon-Session-Id');
      const daemonSessionId = normalizeDaemonSessionId(rawDaemonSessionId);

      if (rawDaemonSessionId && !daemonSessionId) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Invalid daemon session ID',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      // A message claimed by a previous daemon process has an indeterminate
      // delivery result. Never put it back in the send queue automatically: the
      // old process may have handed it to the modem before restarting. Mark it
      // explicitly unknown so a human can decide whether to send a new message.
      // The NULL branch safely adopts records created by pre-session daemons,
      // after allowing their normal send/report window to expire.
      if (daemonSessionId) {
        await env.DB.prepare(
          `
          UPDATE messages
          SET status = 'unknown',
              error_message = 'Daemon restarted before confirming SMS delivery; delivery status is unknown',
              processing_session_id = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE type = 'sent'
            AND status = 'processing'
            AND (
              (processing_session_id IS NOT NULL AND processing_session_id <> ?)
              OR (
                processing_session_id IS NULL
                AND datetime(updated_at) <= datetime('now', '-5 minutes')
              )
            )
        `,
        )
          .bind(daemonSessionId)
          .run();
      }

      // Get pending SMS messages and atomically mark as 'processing' to prevent duplicate sends
      // This prevents the race condition where daemon polls again before status update completes

      // First, get IDs of pending messages
      const pendingIds = await env.DB.prepare(
        `
        SELECT id
        FROM (
          SELECT
            id,
            purpose,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY purpose ORDER BY created_at, id) AS purpose_rank
          FROM messages
          WHERE type = 'sent' AND status = 'sending'
        ) pending
        WHERE purpose != 'balance_maintenance' OR purpose_rank <= 5
        ORDER BY CASE WHEN purpose = 'balance_maintenance' THEN 1 ELSE 0 END,
                 created_at,
                 id
        LIMIT 50
      `,
      ).all<{ id: string }>();

      if (!pendingIds.results || pendingIds.results.length === 0) {
        return json({ success: true, pending_messages: [] });
      }

      // Atomically update status to 'processing' and fetch message details
      const ids = pendingIds.results.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(',');

      // Update to 'processing' status
      await env.DB.prepare(
        `
        UPDATE messages
        SET status = 'processing',
            processing_session_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `,
      )
        .bind(daemonSessionId, ...ids)
        .run();

      // Fetch the updated messages
      const messages = await env.DB.prepare(
        `
        SELECT id, phone_iccid, phone_number, content, recipient, purpose, created_at
        FROM messages
        WHERE id IN (${placeholders})
        ORDER BY created_at ASC
      `,
      )
        .bind(...ids)
        .all();

      return new Response(
        JSON.stringify({
          success: true,
          pending_messages: messages.results || [],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('Get pending SMS error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to get pending SMS',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },

  // Update SMS send result from daemon
  async updateSMSResult(request: AppRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = requireApiKey(request, env);
    if (unauthorized) return unauthorized;

    try {
      const { message_id, outcome, error_message, sms_id } = (await request.json()) as {
        message_id?: unknown;
        outcome?: unknown;
        error_message?: unknown;
        sms_id?: unknown;
      };

      if (!message_id) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'message_id is required',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (outcome !== 'confirmed' && outcome !== 'submitted_unconfirmed' && outcome !== 'failed') {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'outcome must be confirmed, submitted_unconfirmed, or failed',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      // Update message status
      const status = SMS_STATUS_FOR_OUTCOME[outcome as SmsOutcome];
      const stmt = env.DB.prepare(`
        UPDATE messages 
        SET status = ?, error_message = ?, sms_id = ?,
            processing_session_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      const result = await stmt
        .bind(status, error_message || null, sms_id || null, message_id)
        .run();

      if (result.meta.changes === 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Message not found',
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      // The helper is still JS, and its `errorMessage = null` default types the
      // parameter as null | undefined. A string is valid at runtime.
      await updateBalanceCheckForSmsResult(
        env.DB,
        String(message_id),
        outcome,
        typeof error_message === 'string' ? error_message : null,
      );

      // Status updates are now picked up by polling

      return new Response(
        JSON.stringify({
          success: true,
          message: 'SMS result updated successfully',
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('Update SMS result error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to update SMS result',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },

  // Clear all messages (admin endpoint)
  async clearMessages(request: AppRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = requireApiKey(request, env);
    if (unauthorized) return unauthorized;

    try {
      const result = await env.DB.prepare('DELETE FROM messages').run();

      return new Response(
        JSON.stringify({
          success: true,
          message: `Cleared ${result.meta.changes} messages`,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('[control.js] Clear messages error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to clear messages: ' + (error as Error).message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },

  // Daemon heartbeat endpoint
  async heartbeat(request: AppRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = requireApiKey(request, env);
    if (unauthorized) return unauthorized;

    try {
      const body = (await request.json()) as Record<string, unknown>;
      const clientIp =
        request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For') ||
        'unknown';

      const snapshot = normalizeHealthSnapshot(body);
      await env.DB.prepare(
        `
          INSERT INTO daemon_health (
            daemon_id, last_heartbeat, status, last_ip, version,
            error_count, metadata, current_session_id, updated_at
          ) VALUES (
            'orange-pi-main', CURRENT_TIMESTAMP, 'online', ?, ?,
            0, ?, ?, CURRENT_TIMESTAMP
          )
          ON CONFLICT(daemon_id) DO UPDATE SET
            last_heartbeat = CURRENT_TIMESTAMP,
            status = 'online',
            last_ip = excluded.last_ip,
            version = excluded.version,
            error_count = excluded.error_count,
            metadata = excluded.metadata,
            current_session_id = excluded.current_session_id,
            updated_at = CURRENT_TIMESTAMP
      `,
      )
        .bind(clientIp, snapshot.version, JSON.stringify(snapshot), snapshot.session_id)
        .run();

      console.log(
        `[control.js] Health snapshot received: session=${snapshot.session_id}, version=${snapshot.version}`,
      );

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Heartbeat received',
          received_at: new Date().toISOString(),
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('[control.js] Heartbeat error:', error);
      const message = (error as Error).message;
      const status =
        message?.startsWith('Unsupported health schema') || message?.includes('required')
          ? 400
          : 500;
      return new Response(
        JSON.stringify({
          success: false,
          error: `Failed to process heartbeat: ${(error as Error).message}`,
        }),
        {
          status,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  },
};

// Process keywords for a message
async function processMessageKeywords(db: D1Database, message: StoredMessage): Promise<void> {
  try {
    // Get active keywords
    const { results: keywords } = await db
      .prepare(
        `
      SELECT id, keyword, tag, color, priority, case_sensitive, whole_word
      FROM keyword_tags
      WHERE is_active = TRUE
      ORDER BY priority DESC
    `,
      )
      .all<{ id: number; keyword: string; case_sensitive: number; whole_word: number }>();

    if (keywords.length === 0) return;

    // Find matches for each keyword
    const matches: Array<{
      message_id: string;
      keyword_tag_id: number;
      matched_text: string;
      position: number;
    }> = [];
    for (const keyword of keywords) {
      const keywordMatches = findKeywordMatches(
        message.content,
        keyword.keyword,
        Boolean(keyword.case_sensitive),
        Boolean(keyword.whole_word),
      );
      for (const match of keywordMatches) {
        matches.push({
          message_id: message.id,
          keyword_tag_id: keyword.id,
          matched_text: match.text,
          position: match.position,
        });
      }
    }

    // Insert matches in batch if any found
    if (matches.length > 0) {
      const placeholders = matches.map(() => '(?, ?, ?, ?)').join(',');
      const values = matches.flatMap((m) => [
        m.message_id,
        m.keyword_tag_id,
        m.matched_text,
        m.position,
      ]);

      await db
        .prepare(
          `
        INSERT OR IGNORE INTO message_tags (message_id, keyword_tag_id, matched_text, position)
        VALUES ${placeholders}
      `,
        )
        .bind(...values)
        .run();

      console.log(
        `[control.js] Processed ${matches.length} keyword matches for message ${message.id}`,
      );
    }
  } catch (error) {
    console.error(`[control.js] Keyword processing error for message ${message.id}:`, error);
  }
}
