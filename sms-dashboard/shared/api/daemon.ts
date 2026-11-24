// What the Pi daemon sends to its /api/control/ routes and what it is answered.
// Each request schema is bound to the Rust wire type it accepts (ts-rs, under
// daemon-wire/), and its messages are the ones the daemon's logs have always
// shown. Each answer lists its keys in the order the Worker writes them:
// shared/control-fixtures/ compares the bytes.
import * as v from 'valibot';
import type { MessageBatchRequest } from '../daemon-wire/MessageBatchRequest.js';
import type { ModemReportsRequest } from '../daemon-wire/ModemReportsRequest.js';
import type { SmsResult } from '../daemon-wire/SmsResult.js';
import { acceptsWire } from '../wire-schema.js';
import { bodyObject } from './body.js';

const ARRAYS_REQUIRED = 'modem_reports and removed_equipment_ids must be arrays';
const INVALID_REPORT = 'Invalid modem report';
export const INVALID_SYNC = 'Invalid sync mode or missing full-sync session ID';
export const INVALID_REMOVED = 'Invalid or conflicting removed equipment IDs';
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
const ModemReport = v.object(
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

/** POST /api/control/devices. */
export const DevicesBody = acceptsWire<ModemReportsRequest, 'timestamp'>()(
  bodyObject(
    {
      modem_reports: v.array(ModemReport, ARRAYS_REQUIRED),
      removed_equipment_ids: v.array(v.string(INVALID_REMOVED), ARRAYS_REQUIRED),
      sync_mode: v.nullish(v.picklist(['incremental', 'full'], INVALID_SYNC), 'incremental'),
      session_id: v.nullish(v.string(INVALID_SYNC), null),
    },
    { modem_reports: ARRAYS_REQUIRED, removed_equipment_ids: ARRAYS_REQUIRED },
    ARRAYS_REQUIRED,
  ),
);

export const DevicesResponse = v.object({
  success: v.literal(true),
  sync_mode: v.picklist(['incremental', 'full']),
  session_id: v.nullable(v.string()),
  processed: v.object({ modem_reports: v.number(), modems_disconnected: v.number() }),
});

export type DevicesResponse = v.InferOutput<typeof DevicesResponse>;

/** POST /api/control/messages. */
export const UploadBody = acceptsWire<MessageBatchRequest, 'direction'>()(
  bodyObject(
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
    { messages: MESSAGES_REQUIRED },
    MESSAGES_REQUIRED,
  ),
);

/** One uploaded message's verdict (daemon-wire UploadResult). */
const UploadResult = v.object({
  id: v.string(),
  status: v.picklist(['stored', 'already_stored', 'rejected']),
  retryable: v.optional(v.boolean()),
});

export const UploadResponse = v.object({
  success: v.literal(true),
  processed: v.number(),
  results: v.array(UploadResult),
  message: v.string(),
});

export type UploadResponse = v.InferOutput<typeof UploadResponse>;

/** DELETE /api/control/messages. */
export const ClearMessagesResponse = v.object({ success: v.literal(true), message: v.string() });

export type ClearMessagesResponse = v.InferOutput<typeof ClearMessagesResponse>;

/** POST /api/control/cleanup-test-data. */
export const CleanupBody = bodyObject(
  {
    phoneIds: v.pipe(
      v.array(requiredText(PHONE_IDS_INVALID), PHONE_IDS_REQUIRED),
      v.minLength(1, PHONE_IDS_INVALID),
    ),
  },
  { phoneIds: PHONE_IDS_REQUIRED },
  PHONE_IDS_REQUIRED,
);

export const CleanupResponse = v.object({
  success: v.literal(true),
  deleted: v.number(),
  cleanedNullIccid: v.number(),
  message: v.string(),
});

export type CleanupResponse = v.InferOutput<typeof CleanupResponse>;

/** GET /api/control/pending-sms: the daemon process names itself; the handler checks the name. */
export const PendingSmsHeaders = v.object({ 'x-daemon-session-id': v.optional(v.string()) });

/** One SMS for the daemon to send (daemon-wire PendingSms), with the SIM's number. */
const PendingMessage = v.object({
  id: v.string(),
  phone_iccid: v.string(),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  recipient: v.string(),
  purpose: v.picklist(['user', 'balance_maintenance']),
  created_at: v.string(),
});

export const PendingSmsResponse = v.object({
  success: v.literal(true),
  pending_messages: v.array(PendingMessage),
});

export type PendingSmsResponse = v.InferOutput<typeof PendingSmsResponse>;

/** POST /api/control/sms-result. */
export const SmsResultBody = acceptsWire<SmsResult>()(
  bodyObject(
    {
      message_id: requiredText(MESSAGE_ID_MISSING),
      outcome: v.picklist(['confirmed', 'submitted_unconfirmed', 'failed'], INVALID_OUTCOME),
      error_message: v.nullish(v.string('error_message must be text')),
      sms_id: v.nullish(v.string('sms_id must be text')),
    },
    { outcome: INVALID_OUTCOME },
    MESSAGE_ID_MISSING,
  ),
);

export const SmsResultResponse = v.object({ success: v.literal(true), message: v.string() });

export type SmsResultResponse = v.InferOutput<typeof SmsResultResponse>;
