import * as v from 'valibot';
import type { EndedCallRequest } from '../daemon-wire/EndedCallRequest.js';
import type { IncomingCallRequest } from '../daemon-wire/IncomingCallRequest.js';
import { acceptsWire } from '../wire-schema.js';
import { bodyObject } from './body.js';

export const DIRECTIONS = ['inbound', 'outbound'] as const;
const CALL_STATES = ['ringing', 'connecting', 'bridging', 'active', 'ending', 'ended'] as const;
export const ENDED_OUTCOMES = ['answered', 'missed', 'rejected', 'cancelled', 'failed'] as const;

export type Direction = (typeof DIRECTIONS)[number];

export const SessionDescription = v.object({
  type: v.picklist(['offer', 'answer']),
  sdp: v.string(),
});

export type SessionDescription = v.InferOutput<typeof SessionDescription>;

const ICCID_MESSAGE = 'iccid is required';
const NUMBER_MESSAGE = 'number must be E.164, for example +6591234567';
const MEDIA_MESSAGE = 'offer and mid are required';
const ANSWER_MESSAGE = 'answer is required';
const CALL_ID_MESSAGE = 'Invalid call ID';

/** E.164 only: a loose pattern in a dialer turns a typo into a wrong number. */
export const PhoneNumber = v.pipe(
  v.string(NUMBER_MESSAGE),
  v.regex(/^\+[1-9]\d{6,14}$/, NUMBER_MESSAGE),
);

function sessionDescriptionBody<Type extends 'offer' | 'answer'>(type: Type, message: string) {
  return v.object(
    {
      type: v.literal(type, message),
      sdp: v.pipe(v.string(message), v.minLength(1, message)),
    },
    message,
  );
}

const Mid = v.pipe(v.string(MEDIA_MESSAGE), v.minLength(1, MEDIA_MESSAGE));
const CallId = v.optional(v.pipe(v.string(CALL_ID_MESSAGE), v.minLength(1, CALL_ID_MESSAGE)));

export const DialBody = bodyObject(
  {
    iccid: v.pipe(v.string(ICCID_MESSAGE), v.regex(/^[0-9A-Fa-f]{18,22}$/, ICCID_MESSAGE)),
    number: PhoneNumber,
    offer: sessionDescriptionBody('offer', MEDIA_MESSAGE),
    mid: Mid,
  },
  { iccid: ICCID_MESSAGE, number: NUMBER_MESSAGE, offer: MEDIA_MESSAGE, mid: MEDIA_MESSAGE },
);

export const AnswerBody = bodyObject(
  { offer: sessionDescriptionBody('offer', MEDIA_MESSAGE), mid: Mid },
  { offer: MEDIA_MESSAGE, mid: MEDIA_MESSAGE },
);

export const CallIdBody = v.optional(bodyObject({ call_id: CallId }, {}), {});

export const RenegotiateBody = bodyObject(
  { answer: sessionDescriptionBody('answer', ANSWER_MESSAGE), call_id: CallId },
  { answer: ANSWER_MESSAGE },
);

/** The handler bounds the page and keeps any text. */
export const CallHistoryQuery = v.object({
  limit: v.optional(v.string()),
  offset: v.optional(v.string()),
  iccid: v.optional(v.string()),
});

export const LiveCall = v.object({
  id: v.string(),
  direction: v.picklist(DIRECTIONS),
  state: v.picklist(CALL_STATES),
  iccid: v.string(),
  number: v.nullable(v.string()),
  started_at: v.string(),
  requested_by: v.optional(v.nullable(v.string())),
  answered_at: v.optional(v.string()),
  answered_by: v.optional(v.nullable(v.string())),
  session_id: v.optional(v.string()),
  modem_session_id: v.optional(v.string()),
  bridge_started: v.optional(v.literal(true)),
  ended_at: v.optional(v.string()),
  adapters: v.optional(v.object({ up: v.optional(v.string()), down: v.optional(v.string()) })),
});

export type LiveCall = v.InferOutput<typeof LiveCall>;

export const CallHistoryRow = v.object({
  id: v.string(),
  direction: v.picklist(DIRECTIONS),
  iccid: v.string(),
  remote_number: v.nullable(v.string()),
  outcome: v.picklist(ENDED_OUTCOMES),
  end_reason: v.nullable(v.string()),
  started_at: v.string(),
  answered_at: v.nullable(v.string()),
  ended_at: v.nullable(v.string()),
  duration_seconds: v.number(),
  requested_by: v.nullable(v.string()),
  answered_by: v.nullable(v.string()),
});

export type CallHistoryRow = v.InferOutput<typeof CallHistoryRow>;

export const CallLogEntry = v.object({
  ...CallHistoryRow.entries,
  sim_index: v.nullable(v.number()),
  sim_number: v.nullable(v.string()),
  sim_carrier: v.nullable(v.string()),
});

export type CallLogEntry = v.InferOutput<typeof CallLogEntry>;

export const IceServersResponse = v.object({
  iceServers: v.array(
    v.object({
      urls: v.union([v.string(), v.array(v.string())]),
      username: v.optional(v.string()),
      credential: v.optional(v.string()),
    }),
  ),
});

export type IceServersResponse = v.InferOutput<typeof IceServersResponse>;

export const CallStateResponse = v.object({ call: v.nullable(LiveCall) });

export type CallStateResponse = v.InferOutput<typeof CallStateResponse>;

export const CallHistoryResponse = v.object({
  calls: v.array(CallLogEntry),
  has_more: v.boolean(),
});

export type CallHistoryResponse = v.InferOutput<typeof CallHistoryResponse>;

export const CallMediaResponse = v.object({ call: LiveCall, answer: SessionDescription });

export type CallMediaResponse = v.InferOutput<typeof CallMediaResponse>;

export const CallConnectResponse = v.object({
  call: LiveCall,
  offer: v.nullable(SessionDescription),
});

export type CallConnectResponse = v.InferOutput<typeof CallConnectResponse>;

export const CallRenegotiateResponse = v.object({ call: LiveCall });

export type CallRenegotiateResponse = v.InferOutput<typeof CallRenegotiateResponse>;

export const CallHangupResponse = v.union([
  v.object({ call: v.null(), already_clear: v.literal(true) }),
  v.object({ call: LiveCall }),
]);

export type CallHangupResponse = v.InferOutput<typeof CallHangupResponse>;

/** `from` is null until the network sends a caller id. */
export const IncomingCallBody = acceptsWire<IncomingCallRequest>()(
  bodyObject(
    {
      iccid: v.pipe(v.string(ICCID_MESSAGE), v.minLength(1, ICCID_MESSAGE)),
      from: v.nullish(v.string('from must be a string')),
    },
    { iccid: ICCID_MESSAGE },
  ),
);

export const IncomingCallResponse = v.union([
  v.object({ ok: v.literal(true), call: LiveCall }),
  v.object({ ok: v.literal(true), ignored: v.literal(true) }),
]);

export type IncomingCallResponse = v.InferOutput<typeof IncomingCallResponse>;

/** `call_id` is null for a ring that stopped unanswered. */
export const EndedCallBody = acceptsWire<EndedCallRequest>()(
  v.pipe(
    bodyObject(
      {
        call_id: v.nullish(v.string(CALL_ID_MESSAGE)),
        iccid: v.nullish(v.string('iccid must be a string')),
        reason: v.nullish(v.string('reason must be a string')),
      },
      {},
    ),
    v.check(
      ({ call_id, iccid }) => (call_id ?? '') !== '' || (iccid ?? '') !== '',
      'call_id or iccid is required',
    ),
  ),
);

export const EndedCallResponse = v.union([
  v.object({ ok: v.literal(true), ignored: v.literal(true) }),
  v.object({ ok: v.literal(true), call_id: v.string() }),
]);

export type EndedCallResponse = v.InferOutput<typeof EndedCallResponse>;
