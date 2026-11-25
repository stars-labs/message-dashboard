import { ORPCError } from '@orpc/server';
import { json } from '../lib/response.js';
import * as v from 'valibot';
import type { D1, D1Batch } from '../lib/d1.js';
import {
  failUnsendableMessages,
  insertReceivedMessage,
  listMessagesByIds,
  listSendingMessageIds,
  markMessagesProcessing,
  markStaleProcessingMessagesUnknown,
  updateSmsResult,
  upsertDaemonHeartbeat,
} from '../db/daemon.js';
import { insertKeywordMatches, listActiveKeywordMatchers } from '../db/keywords.js';
import { disconnectModems, disconnectModemsAbsentFrom, upsertModemReports } from '../db/modems.js';
import { secretMatches } from '../lib/secret.js';
import { textOr } from '../../shared/text.js';
import type { PendingSms } from '../../shared/daemon-wire/PendingSms.js';
import {
  INVALID_REMOVED,
  INVALID_SYNC,
  type DevicesBody,
  type DevicesResponse,
  type PendingSmsResponse,
  type SmsResultBody,
  type SmsResultResponse,
  type UploadBody,
  type UploadResponse,
} from '../../shared/api/daemon.js';
import { processCarrierBillMessages } from '../utils/carrier-billing.js';
import { errorText } from '../../shared/error-text.js';
import { normalizeHealthSnapshot } from '../utils/daemon-health.js';
import type { HealthSnapshot } from '../../shared/api/daemon-status.js';
import type { HeartbeatResponse } from '../../shared/api/contract/control.js';
import { findKeywordMatches } from '../utils/keyword-match.js';
import { classifyMessage, loadActiveRules } from '../utils/spam-filter.js';
import { extractVerificationCode } from '../utils/verification.js';
import type { BalanceCheckRow } from '../db/balance-replies.js';
import { mergeMultipartReplies } from '../utils/balance-reply-parse.js';
import {
  findPendingBalanceCheck,
  linkBalanceReply,
  updateBalanceCheckForSmsResult,
  type SmsOutcome,
} from './balance-replies.js';

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

/** A daemon route as the contract hands it over, once the API key has been checked. */
interface DaemonCall<Db> {
  env: { DB: Db };
}

interface UploadCall extends DaemonCall<D1 & D1Batch<'run'>> {
  ctx: { waitUntil(promise: Promise<unknown>): void };
}

/** A refusal in the route's own error format. */
function refused(code: 'BAD_REQUEST' | 'NOT_FOUND', message: string): ORPCError<string, undefined> {
  return new ORPCError(code, { message });
}

/** Rethrows a refusal the handler chose; any other failure answers 500 with `message`. */
function failed(error: unknown, message: string): never {
  if (error instanceof ORPCError) throw error;
  throw new ORPCError('INTERNAL_SERVER_ERROR', { message });
}

/** How every /api/control/ route refuses a caller it does not admit. */
export function unauthorized(): Response {
  return json({ error: 'Unauthorized' }, 401);
}

/** Control routes use the daemon's shared API key, never Auth0. Returns a Response when it is wrong. */
export async function requireApiKey(request: DaemonRequest<unknown>): Promise<Response | null> {
  if (!(await secretMatches(request.headers.get('X-API-Key'), request.env.API_KEY))) {
    return unauthorized();
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
  async updateDevices(
    { env }: DaemonCall<D1<'run'> & D1Batch<'run'>>,
    body: v.InferOutput<typeof DevicesBody>,
  ): Promise<DevicesResponse> {
    const {
      modem_reports: reports,
      removed_equipment_ids: removedEquipmentIds,
      sync_mode,
      session_id,
    } = body;

    if (sync_mode === 'full' && !session_id) throw refused('BAD_REQUEST', INVALID_SYNC);

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
        throw refused('BAD_REQUEST', INVALID_REMOVED);
      }
      const verificationStatus = sync_mode === 'full' ? 'verified' : null;
      const lastVerifiedSession = sync_mode === 'full' ? session_id : null;

      await upsertModemReports(env.DB, acceptedReports, verificationStatus, lastVerifiedSession);

      let explicitlyDisconnected = 0;
      if (removedIds.length > 0) {
        explicitlyDisconnected = await disconnectModems(env.DB, removedIds);
      }

      let reconciledDisconnected = 0;
      if (sync_mode === 'full') {
        reconciledDisconnected = await disconnectModemsAbsentFrom(
          env.DB,
          acceptedReports.map((report) => report.equipment_id),
        );
      }

      return {
        success: true,
        sync_mode,
        session_id,
        processed: {
          modem_reports: acceptedReports.length,
          modems_disconnected: explicitlyDisconnected + reconciledDisconnected,
        },
      };
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      console.error('[control] Database error in updateDevices:', error);
      // The daemon expects { success: false, error } on failure.
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        data: { wire: { success: false, error: 'Failed to update devices' } },
      });
    }
  },

  async uploadMessages(
    { env, ctx }: UploadCall,
    { messages }: v.InferOutput<typeof UploadBody>,
  ): Promise<UploadResponse> {
    try {
      let processed = 0;
      const results: UploadResponse['results'] = [];
      const newMessages: StoredMessage[] = [];

      // Classified inline, not in ctx.waitUntil: a row must never be readable while
      // still 'pending', or marketing SMS would flash into the default list.
      const filterRules = await loadActiveRules(env.DB);

      // Parts of one carrier reply must be grouped before linking, or the check
      // closes on whichever part is processed first.
      const multipartReplies = mergeMultipartReplies(messages);
      // Group key -> the check that claimed it.
      const claimedReplyGroups = new Map<string, BalanceCheckRow>();

      for (const msg of messages) {
        const messageId = msg.id;
        try {
          const timestamp = normalizeTimestamp(msg.timestamp);
          const phoneNumber = msg.phone_number ?? null;
          const reply = multipartReplies.get(messageId);
          // A later part reuses its group's check; re-running the pending lookup could
          // queue a duplicate follow-up.
          const groupClaim = reply ? (claimedReplyGroups.get(reply.key) ?? null) : null;
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

          // phone_number is the sender's number, which the sender rules match on.
          const verdict = balanceCheck
            ? { filter_status: 'filtered', filter_rule_id: null }
            : classifyMessage(record, filterRules);

          // The primary key is the sole idempotency boundary: equal payloads may be distinct SMS.
          const changes = await insertReceivedMessage(env.DB, {
            id: messageId,
            phone_iccid: msg.phone_iccid,
            phone_number: phoneNumber,
            content: msg.content,
            timestamp,
            verification_code: verificationCode,
            filter_status: verdict.filter_status,
            filter_rule_id: verdict.filter_rule_id,
            purpose: record.purpose,
            balance_check_id: record.balance_check_id,
          });

          if (changes === 0) {
            results.push({ id: messageId, status: 'already_stored' });
            continue;
          }

          processed += 1;
          results.push({ id: messageId, status: 'stored' });
          // Only a new message triggers side effects; for a multi-part reply, only the
          // part that claimed the check, using the merged text.
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
          // The daemon retries retryable rejections; the others become dead_letter locally.
          const retryable = !(err instanceof TypeError);
          console.error(
            `[control] Message ${messageId} failed (retryable=${String(retryable)}):`,
            err,
          );
          results.push({ id: messageId, status: 'rejected', retryable });
        }
      }

      if (newMessages.length > 0) {
        ctx.waitUntil(
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

      return {
        success: true,
        processed,
        results,
        message: `Successfully uploaded ${String(processed)} messages`,
      };
    } catch (error) {
      console.error('[control] Upload messages error:', error);
      failed(error, `Failed to upload messages: ${errorText(error)}`);
    }
  },

  // Status flow: 'sending' -> 'processing' (claimed on poll) -> 'sent'/'failed'/'unknown'
  // (daemon report). Claiming on poll keeps a repeat poll from sending a message twice.
  async getPendingSMS(
    { env }: DaemonCall<D1<'all' | 'run'>>,
    rawDaemonSessionId: string | undefined,
  ): Promise<PendingSmsResponse> {
    try {
      const daemonSessionId = normalizeDaemonSessionId(rawDaemonSessionId);

      if (rawDaemonSessionId && !daemonSessionId) {
        throw refused('BAD_REQUEST', 'Invalid daemon session ID');
      }

      // A message claimed by a previous daemon process may already have reached the
      // modem, so never requeue it: mark it unknown for a human to decide.
      if (daemonSessionId) {
        await markStaleProcessingMessagesUnknown(env.DB, daemonSessionId);
      }

      // The daemon's PendingSms requires both numbers; fail what lacks one.
      await failUnsendableMessages(env.DB);

      const ids = await listSendingMessageIds(env.DB);

      if (ids.length === 0) {
        return { success: true, pending_messages: [] };
      }

      await markMessagesProcessing(env.DB, daemonSessionId, ids);

      const messages = await listMessagesByIds(env.DB, ids);

      const pendingMessages = messages satisfies PendingSms[];
      return { success: true, pending_messages: pendingMessages };
    } catch (error) {
      console.error('Get pending SMS error:', error);
      failed(error, 'Failed to get pending SMS');
    }
  },

  async updateSMSResult(
    { env }: DaemonCall<D1<'run'>>,
    { message_id, outcome, error_message, sms_id }: v.InferOutput<typeof SmsResultBody>,
  ): Promise<SmsResultResponse> {
    try {
      const changes = await updateSmsResult(
        env.DB,
        message_id,
        SMS_STATUS_FOR_OUTCOME[outcome],
        textOr(error_message, null),
        textOr(sms_id, null),
      );

      if (changes === 0) {
        throw refused('NOT_FOUND', 'Message not found');
      }

      await updateBalanceCheckForSmsResult(env.DB, message_id, outcome, error_message ?? null);

      return { success: true, message: 'SMS result updated successfully' };
    } catch (error) {
      console.error('Update SMS result error:', error);
      failed(error, 'Failed to update SMS result');
    }
  },
};

interface HeartbeatCall {
  headers: { get(name: string): string | null };
  env: { DB: D1<'run'> };
}

/** POST /api/control/heartbeat: store the daemon's health snapshot. */
export async function recordHeartbeat(
  { headers, env }: HeartbeatCall,
  raw: unknown,
): Promise<HeartbeatResponse> {
  let snapshot: HealthSnapshot;
  try {
    snapshot = normalizeHealthSnapshot(raw);
  } catch (error) {
    throw new ORPCError('BAD_REQUEST', {
      message: `Failed to process heartbeat: ${errorText(error)}`,
    });
  }

  try {
    const clientIp = textOr(
      headers.get('CF-Connecting-IP'),
      textOr(headers.get('X-Forwarded-For'), 'unknown'),
    );
    await upsertDaemonHeartbeat(env.DB, {
      clientIp,
      version: snapshot.version,
      metadata: JSON.stringify(snapshot),
      sessionId: snapshot.session_id,
    });

    console.log(
      `[control] Health snapshot received: session=${snapshot.session_id}, version=${snapshot.version}`,
    );

    return { success: true, message: 'Heartbeat received', received_at: new Date().toISOString() };
  } catch (error) {
    console.error('[control] Heartbeat error:', error);
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: `Failed to process heartbeat: ${errorText(error)}`,
    });
  }
}

async function processMessageKeywords(
  db: D1<'all' | 'run'>,
  message: StoredMessage,
): Promise<void> {
  try {
    const keywords = await listActiveKeywordMatchers(db);

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
      await insertKeywordMatches(db, matches);

      console.log(
        `[control] Processed ${String(matches.length)} keyword matches for message ${message.id}`,
      );
    }
  } catch (error) {
    console.error(`[control] Keyword processing error for message ${message.id}:`, error);
  }
}
