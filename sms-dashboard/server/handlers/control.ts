import { json } from '../lib/response.js';
import * as v from 'valibot';
import { readJson } from '../../shared/parse-json.js';
import { queryAll, type D1, type D1Batch } from '../lib/d1.js';
import { NOT_JSON_MESSAGE, readBody, type MissingKeyMessages } from '../lib/request-body.js';
import { secretMatches } from '../lib/secret.js';
import { textOr } from '../lib/text.js';
import { processCarrierBillMessages } from '../utils/carrier-billing.js';
import { errorText } from '../utils/d1-error.js';
import { normalizeHealthSnapshot, type HealthSnapshot } from '../utils/daemon-health.js';
import { findKeywordMatches } from '../utils/keyword-match.js';
import { classifyMessage, loadActiveRules } from '../utils/spam-filter.js';
import { extractVerificationCode } from '../utils/verification.js';
import {
  findPendingBalanceCheck,
  linkBalanceReply,
  mergeMultipartReplies,
  updateBalanceCheckForSmsResult,
  type BalanceCheckRow,
  type SmsOutcome,
} from './balance-queries.js';

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

const ARRAYS_REQUIRED = 'modem_reports and removed_equipment_ids must be arrays';
const INVALID_REPORT = 'Invalid modem report';
const INVALID_SYNC = 'Invalid sync mode or missing full-sync session ID';
const INVALID_REMOVED = 'Invalid or conflicting removed equipment IDs';
const MESSAGES_REQUIRED = 'Messages must be an array';
const MESSAGE_ID_REQUIRED = 'Every message requires a daemon-assigned id';
const MESSAGE_FIELDS_REQUIRED = 'Every message requires phone_iccid and content';
const MESSAGE_FIELDS_NOT_TEXT = 'phone_number and timestamp must be text';
const MESSAGE_ID_MISSING = 'message_id is required';
const INVALID_OUTCOME = 'outcome must be confirmed, submitted_unconfirmed, or failed';
const PHONE_IDS_REQUIRED = 'phoneIds must be an array';
const PHONE_IDS_INVALID = 'phoneIds must be a non-empty array of ICCIDs';

/** Required text whose absence answers the same message as a wrong type or an empty value. */
function requiredText(message: string) {
  return v.pipe(v.optional(v.string(message), ''), v.minLength(1, message));
}

const ReportText = v.nullish(v.string(INVALID_REPORT));
const ReportInteger = v.nullish(v.pipe(v.number(INVALID_REPORT), v.integer(INVALID_REPORT)));

/** One entry of the daemon's modem_reports array (orange-pi-daemon types.rs ModemReport). */
const ModemReportSchema = v.object(
  {
    equipment_id: v.string(INVALID_REPORT),
    manufacturer: ReportText,
    model: ReportText,
    firmware_revision: ReportText,
    hardware_revision: ReportText,
    detected_iccid: ReportText,
    detected_phone_number: ReportText,
    detected_operator: ReportText,
    signal_percent: ReportInteger,
    rssi: ReportInteger,
    modem_index: ReportInteger,
    usb_port: ReportInteger,
    usb_path: ReportText,
    status: ReportText,
  },
  INVALID_REPORT,
);

const DevicesBodySchema = v.object(
  {
    modem_reports: v.array(ModemReportSchema, ARRAYS_REQUIRED),
    removed_equipment_ids: v.array(v.string(INVALID_REMOVED), ARRAYS_REQUIRED),
    sync_mode: v.nullish(v.picklist(['incremental', 'full'], INVALID_SYNC), 'incremental'),
    session_id: v.nullish(v.string(INVALID_SYNC), null),
  },
  ARRAYS_REQUIRED,
);

const DEVICES_MISSING_KEY_MESSAGES = {
  modem_reports: ARRAYS_REQUIRED,
  removed_equipment_ids: ARRAYS_REQUIRED,
} as const satisfies MissingKeyMessages<typeof DevicesBodySchema>;

const UploadBodySchema = v.object(
  {
    messages: v.array(
      v.object(
        {
          id: requiredText(MESSAGE_ID_REQUIRED),
          phone_iccid: requiredText(MESSAGE_FIELDS_REQUIRED),
          content: requiredText(MESSAGE_FIELDS_REQUIRED),
          phone_number: v.nullish(v.string(MESSAGE_FIELDS_NOT_TEXT)),
          timestamp: v.nullish(v.string(MESSAGE_FIELDS_NOT_TEXT)),
        },
        MESSAGE_ID_REQUIRED,
      ),
      MESSAGES_REQUIRED,
    ),
  },
  MESSAGES_REQUIRED,
);

const UPLOAD_MISSING_KEY_MESSAGES = {
  messages: MESSAGES_REQUIRED,
} as const satisfies MissingKeyMessages<typeof UploadBodySchema>;

const SmsResultBodySchema = v.object(
  {
    message_id: requiredText(MESSAGE_ID_MISSING),
    outcome: v.picklist(['confirmed', 'submitted_unconfirmed', 'failed'], INVALID_OUTCOME),
    error_message: v.nullish(v.string('error_message must be text')),
    sms_id: v.nullish(v.string('sms_id must be text')),
  },
  MESSAGE_ID_MISSING,
);

const SMS_RESULT_MISSING_KEY_MESSAGES = {
  outcome: INVALID_OUTCOME,
} as const satisfies MissingKeyMessages<typeof SmsResultBodySchema>;

const CleanupBodySchema = v.object(
  {
    phoneIds: v.pipe(
      v.array(requiredText(PHONE_IDS_INVALID), PHONE_IDS_REQUIRED),
      v.minLength(1, PHONE_IDS_INVALID),
    ),
  },
  PHONE_IDS_REQUIRED,
);

const CLEANUP_MISSING_KEY_MESSAGES = {
  phoneIds: PHONE_IDS_REQUIRED,
} as const satisfies MissingKeyMessages<typeof CleanupBodySchema>;

const IdRow = v.object({ id: v.string() });

const PendingMessageRow = v.object({
  id: v.string(),
  phone_iccid: v.nullable(v.string()),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  recipient: v.nullable(v.string()),
  purpose: v.picklist(['user', 'balance_maintenance']),
  created_at: v.nullable(v.string()),
});

const KeywordRow = v.object({
  id: v.number(),
  keyword: v.string(),
  case_sensitive: v.nullable(v.number()),
  whole_word: v.nullable(v.number()),
});

const SMS_STATUS_FOR_OUTCOME: Readonly<Record<SmsOutcome, string>> = {
  confirmed: 'sent',
  submitted_unconfirmed: 'unknown',
  failed: 'failed',
};

/** A daemon request: the shared API key, and the D1 operations the route uses. */
interface DaemonRequest<Db> {
  headers: { get(name: string): string | null };
  env: { API_KEY?: string; DB: Db };
}

interface BodyRequest<Db> extends DaemonRequest<Db> {
  text(): Promise<string>;
}

interface UploadRequest extends BodyRequest<D1 & D1Batch<'run'>> {
  ctx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Every control route authenticates with the daemon's shared API key, never
 * Auth0. Returns a Response when the key is wrong.
 */
async function requireApiKey(request: DaemonRequest<unknown>): Promise<Response | null> {
  if (!(await secretMatches(request.headers.get('X-API-Key'), request.env.API_KEY))) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

const DAEMON_SESSION_ID = /^[A-Za-z0-9._:-]{1,120}$/;

export function normalizeDaemonSessionId(value: unknown): string | null {
  return typeof value === 'string' && DAEMON_SESSION_ID.test(value) ? value : null;
}

const SPACED_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{1,2}):(\d{1,2})(\.\d{3})?Z?$/;
const ZONELESS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$/;

/**
 * The daemon's receive time as ISO 8601 UTC. Older daemons sent the date and
 * time separated by a space, a URL-encoded '+', or unpadded fields.
 */
function normalizeTimestamp(value: string | null | undefined): string {
  const timestamp = (value ?? new Date().toISOString()).replace(/\+/g, ' ');
  const match = SPACED_TIMESTAMP.exec(timestamp);
  if (match) {
    const [, year = '', month = '', day = '', hours = '', minutes = '', seconds = '', millis] =
      match;
    return `${year}-${month}-${day}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}${millis ?? '.000'}Z`;
  }
  const compact = timestamp.replace(/\s+/g, '');
  return ZONELESS_TIMESTAMP.test(compact) ? `${compact}Z` : compact;
}

export const controlHandler = {
  // Synchronize the daemon's canonical modem reports without rewriting unchanged rows.
  async updateDevices(request: BodyRequest<D1<'run'> & D1Batch<'run'>>): Promise<Response> {
    const { env } = request;

    const unauthorized = await requireApiKey(request);
    if (unauthorized) return unauthorized;

    const body = await readBody(request, DevicesBodySchema, DEVICES_MISSING_KEY_MESSAGES);
    if (!body.ok) return json({ error: body.error }, 400);
    const {
      modem_reports: reports,
      removed_equipment_ids: removedEquipmentIds,
      sync_mode,
      session_id,
    } = body.value;

    if (sync_mode === 'full' && !session_id) {
      return json({ error: INVALID_SYNC }, 400);
    }

    try {
      console.log(
        `[control] Received ${String(reports.length)} modem_reports (mode: ${sync_mode}, session: ${String(session_id)})`,
      );

      const acceptedReports = reports.filter((report) => {
        if (!report.equipment_id) return false;
        return !(report.equipment_id.startsWith('MODEM_') && !report.manufacturer && !report.model);
      });
      const removedIds = [...new Set(removedEquipmentIds)];
      if (
        removedIds.some((id) => !id) ||
        acceptedReports.some((report) => removedIds.includes(report.equipment_id))
      ) {
        return json({ error: INVALID_REMOVED }, 400);
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
          textOr(report.manufacturer, null),
          textOr(report.model, null),
          textOr(report.firmware_revision, null),
          textOr(report.hardware_revision, null),
          textOr(report.detected_iccid, null),
          textOr(report.detected_phone_number, null),
          textOr(report.detected_operator, null),
          report.signal_percent ?? null,
          report.rssi ?? null,
          report.modem_index ?? null,
          report.usb_port ?? null,
          report.usb_path ?? null,
          report.usb_path ?? null,
          textOr(report.status, 'active'),
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

      return json({
        success: true,
        sync_mode,
        session_id,
        processed: {
          modem_reports: acceptedReports.length,
          modems_disconnected: explicitlyDisconnected + reconciledDisconnected,
        },
      });
    } catch (error) {
      console.error('[control] Database error in updateDevices:', error);
      return json({ success: false, error: 'Failed to update devices' }, 500);
    }
  },

  // Upload messages from Orange Pi
  async uploadMessages(request: UploadRequest): Promise<Response> {
    const { env } = request;

    const unauthorized = await requireApiKey(request);
    if (unauthorized) return unauthorized;

    const body = await readBody(request, UploadBodySchema, UPLOAD_MISSING_KEY_MESSAGES);
    if (!body.ok) return json({ success: false, error: body.error }, 400);
    const { messages } = body.value;

    try {
      let processed = 0;
      const results: { id: string; status: string; retryable?: boolean }[] = [];
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
      const multipartReplies = mergeMultipartReplies(messages);
      // Group key -> the check that claimed it, so later parts join that check.
      const claimedReplyGroups = new Map<string, BalanceCheckRow>();

      for (const msg of messages) {
        const messageId = msg.id;
        try {
          const timestamp = normalizeTimestamp(msg.timestamp);
          const phoneNumber = msg.phone_number ?? null;
          const reply = multipartReplies.get(messageId);
          // A later part reuses its group's check rather than re-running the
          // pending lookup, which would find the same check and could queue a
          // duplicate follow-up for it.
          const groupClaim = reply ? (claimedReplyGroups.get(reply.key) ?? null) : null;
          // findPendingBalanceCheck returns null for a missing number anyway.
          const balanceCheck =
            groupClaim ??
            (await findPendingBalanceCheck(env.DB, {
              phone_iccid: msg.phone_iccid,
              phone_number: phoneNumber ?? '',
              message_timestamp: timestamp,
            }));
          if (reply && !groupClaim && balanceCheck) {
            claimedReplyGroups.set(reply.key, balanceCheck);
          }
          const verificationCode = balanceCheck ? null : extractVerificationCode(msg.content);

          const record: StoredMessage = {
            id: messageId,
            phone_iccid: msg.phone_iccid,
            phone_number: phoneNumber,
            content: msg.content,
            timestamp,
            type: 'received',
            verification_code: verificationCode,
            purpose: balanceCheck ? 'balance_maintenance' : 'user',
            balance_check_id: balanceCheck?.id ?? null,
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
              msg.phone_iccid,
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
                record,
                reply ? { mergedContent: reply.content } : {},
              );
            }
          } else newMessages.push(record);
        } catch (err) {
          // Per-message failure must not abort the batch. The daemon retries
          // transient errors; permanent input errors become dead_letter locally.
          const retryable = !(err instanceof TypeError);
          console.error(
            `[control] Message ${messageId} failed (retryable=${String(retryable)}):`,
            err,
          );
          results.push({ id: messageId, status: 'rejected', retryable });
        }
      }

      // Process new messages with AI and keywords (async, don't wait)
      if (newMessages.length > 0) {
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
            processCarrierBillMessages(env.DB, newMessages),
          ]),
        );
      }

      return json({
        success: true,
        processed,
        results,
        message: `Successfully uploaded ${String(processed)} messages`,
      });
    } catch (error) {
      console.error('[control] Upload messages error:', error);
      return json({ success: false, error: `Failed to upload messages: ${errorText(error)}` }, 500);
    }
  },

  // Cleanup test data
  async cleanupTestData(request: BodyRequest<D1<'run'>>): Promise<Response> {
    const { env } = request;

    const unauthorized = await requireApiKey(request);
    if (unauthorized) return unauthorized;

    const body = await readBody(request, CleanupBodySchema, CLEANUP_MISSING_KEY_MESSAGES);
    if (!body.ok) return json({ success: false, error: body.error }, 400);
    const { phoneIds } = body.value;

    try {
      // Delete test SIMs by ICCID
      const placeholders = phoneIds.map(() => '?').join(',');
      const result = await env.DB.prepare(`DELETE FROM sims WHERE iccid IN (${placeholders})`)
        .bind(...phoneIds)
        .run();

      // Also delete any SIMs without ICCID
      const cleanupNullIccid = await env.DB.prepare(
        `DELETE FROM sims WHERE iccid IS NULL OR iccid = ''`,
      ).run();

      return json({
        success: true,
        deleted: result.meta.changes,
        cleanedNullIccid: cleanupNullIccid.meta.changes,
        message: `Deleted ${String(result.meta.changes)} test SIMs and ${String(cleanupNullIccid.meta.changes)} SIMs without ICCID`,
      });
    } catch (error) {
      console.error('Cleanup error:', error);
      return json({ success: false, error: 'Failed to cleanup test data' }, 500);
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
  async getPendingSMS(request: DaemonRequest<D1<'all' | 'run'>>): Promise<Response> {
    const { env } = request;

    const unauthorized = await requireApiKey(request);
    if (unauthorized) return unauthorized;

    try {
      const rawDaemonSessionId = request.headers.get('X-Daemon-Session-Id');
      const daemonSessionId = normalizeDaemonSessionId(rawDaemonSessionId);

      if (rawDaemonSessionId && !daemonSessionId) {
        return json({ success: false, error: 'Invalid daemon session ID' }, 400);
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

      // Claim pending messages by marking them 'processing', so a poll that
      // arrives before this batch is reported cannot send them twice.
      const pending = await queryAll(
        env.DB.prepare(
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
        ),
        IdRow,
      );

      if (pending.length === 0) {
        return json({ success: true, pending_messages: [] });
      }

      const ids = pending.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(',');

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

      const messages = await queryAll(
        env.DB.prepare(
          `
        SELECT id, phone_iccid, phone_number, content, recipient, purpose, created_at
        FROM messages
        WHERE id IN (${placeholders})
        ORDER BY created_at ASC
      `,
        ).bind(...ids),
        PendingMessageRow,
      );

      return json({ success: true, pending_messages: messages });
    } catch (error) {
      console.error('Get pending SMS error:', error);
      return json({ success: false, error: 'Failed to get pending SMS' }, 500);
    }
  },

  // Update SMS send result from daemon
  async updateSMSResult(request: BodyRequest<D1<'run'>>): Promise<Response> {
    const { env } = request;

    const unauthorized = await requireApiKey(request);
    if (unauthorized) return unauthorized;

    const body = await readBody(request, SmsResultBodySchema, SMS_RESULT_MISSING_KEY_MESSAGES);
    if (!body.ok) return json({ success: false, error: body.error }, 400);
    const { message_id, outcome, error_message, sms_id } = body.value;

    try {
      const result = await env.DB.prepare(
        `
        UPDATE messages
        SET status = ?, error_message = ?, sms_id = ?,
            processing_session_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      )
        .bind(
          SMS_STATUS_FOR_OUTCOME[outcome],
          textOr(error_message, null),
          textOr(sms_id, null),
          message_id,
        )
        .run();

      if (result.meta.changes === 0) {
        return json({ success: false, error: 'Message not found' }, 404);
      }

      await updateBalanceCheckForSmsResult(env.DB, message_id, outcome, error_message ?? null);

      return json({ success: true, message: 'SMS result updated successfully' });
    } catch (error) {
      console.error('Update SMS result error:', error);
      return json({ success: false, error: 'Failed to update SMS result' }, 500);
    }
  },

  // Clear all messages (admin endpoint)
  async clearMessages(request: DaemonRequest<D1<'run'>>): Promise<Response> {
    const { env } = request;

    const unauthorized = await requireApiKey(request);
    if (unauthorized) return unauthorized;

    try {
      const result = await env.DB.prepare('DELETE FROM messages').run();
      return json({ success: true, message: `Cleared ${String(result.meta.changes)} messages` });
    } catch (error) {
      console.error('[control] Clear messages error:', error);
      return json({ success: false, error: `Failed to clear messages: ${errorText(error)}` }, 500);
    }
  },

  // Daemon heartbeat endpoint
  async heartbeat(request: BodyRequest<D1<'run'>>): Promise<Response> {
    const { env } = request;

    const unauthorized = await requireApiKey(request);
    if (unauthorized) return unauthorized;

    const body = await readJson(request, v.unknown());
    if (!body.ok) return json({ success: false, error: NOT_JSON_MESSAGE }, 400);

    // normalizeHealthSnapshot throws only for a snapshot the daemon must not send.
    let snapshot: HealthSnapshot;
    try {
      snapshot = normalizeHealthSnapshot(body.value);
    } catch (error) {
      return json(
        { success: false, error: `Failed to process heartbeat: ${errorText(error)}` },
        400,
      );
    }

    try {
      const clientIp = textOr(
        request.headers.get('CF-Connecting-IP'),
        textOr(request.headers.get('X-Forwarded-For'), 'unknown'),
      );
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
        `[control] Health snapshot received: session=${snapshot.session_id}, version=${snapshot.version}`,
      );

      return json({
        success: true,
        message: 'Heartbeat received',
        received_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[control] Heartbeat error:', error);
      return json(
        { success: false, error: `Failed to process heartbeat: ${errorText(error)}` },
        500,
      );
    }
  },
};

// Process keywords for a message
async function processMessageKeywords(
  db: D1<'all' | 'run'>,
  message: StoredMessage,
): Promise<void> {
  try {
    const keywords = await queryAll(
      db.prepare(
        `
      SELECT id, keyword, case_sensitive, whole_word
      FROM keyword_tags
      WHERE is_active = TRUE
      ORDER BY priority DESC
    `,
      ),
      KeywordRow,
    );

    if (keywords.length === 0) return;

    const matches = keywords.flatMap((keyword) =>
      findKeywordMatches(
        message.content,
        keyword.keyword,
        Boolean(keyword.case_sensitive),
        Boolean(keyword.whole_word),
      ).map((match) => [message.id, keyword.id, match.text, match.position] as const),
    );

    if (matches.length > 0) {
      const placeholders = matches.map(() => '(?, ?, ?, ?)').join(',');
      await db
        .prepare(
          `
        INSERT OR IGNORE INTO message_tags (message_id, keyword_tag_id, matched_text, position)
        VALUES ${placeholders}
      `,
        )
        .bind(...matches.flat())
        .run();

      console.log(
        `[control] Processed ${String(matches.length)} keyword matches for message ${message.id}`,
      );
    }
  } catch (error) {
    console.error(`[control] Keyword processing error for message ${message.id}:`, error);
  }
}
