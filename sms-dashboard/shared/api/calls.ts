import * as v from 'valibot';

export const DIRECTIONS = ['inbound', 'outbound'] as const;
const CALL_STATES = ['ringing', 'connecting', 'bridging', 'active', 'ending', 'ended'] as const;
export const ENDED_OUTCOMES = ['answered', 'missed', 'rejected', 'cancelled', 'failed'] as const;

export type Direction = (typeof DIRECTIONS)[number];

/** An SDP offer or answer, as WebRTC and the Realtime SFU exchange it. */
export const SessionDescription = v.object({
  type: v.picklist(['offer', 'answer']),
  sdp: v.string(),
});

export type SessionDescription = v.InferOutput<typeof SessionDescription>;

/** The live call record the fleet Durable Object holds. */
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

/** A call_log row, every column. */
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

/** A finished call as the history lists it, with the SIM it used. */
export const CallLogEntry = v.object({
  ...CallHistoryRow.entries,
  sim_index: v.nullable(v.number()),
  sim_number: v.nullable(v.string()),
  sim_carrier: v.nullable(v.string()),
});

export type CallLogEntry = v.InferOutput<typeof CallLogEntry>;

/** GET /api/calls/ice: TURN credentials, as Cloudflare issues them. */
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

/** GET /api/calls/state. */
export const CallStateResponse = v.object({ call: v.nullable(LiveCall) });

export type CallStateResponse = v.InferOutput<typeof CallStateResponse>;

/** GET /api/calls/history. */
export const CallHistoryResponse = v.object({
  calls: v.array(CallLogEntry),
  has_more: v.boolean(),
});

export type CallHistoryResponse = v.InferOutput<typeof CallHistoryResponse>;

/** POST /api/calls/dial and /answer: the call, and the SFU's answer to the browser's offer. */
export const CallMediaResponse = v.object({ call: LiveCall, answer: SessionDescription });

export type CallMediaResponse = v.InferOutput<typeof CallMediaResponse>;

/** POST /api/calls/connect: an offer when the SFU asks the browser to renegotiate. */
export const CallConnectResponse = v.object({
  call: LiveCall,
  offer: v.nullable(SessionDescription),
});

export type CallConnectResponse = v.InferOutput<typeof CallConnectResponse>;

/** POST /api/calls/renegotiate. */
export const CallRenegotiateResponse = v.object({ call: LiveCall });

export type CallRenegotiateResponse = v.InferOutput<typeof CallRenegotiateResponse>;

/** POST /api/calls/hangup: the ended call, or none when there was nothing to end. */
export const CallHangupResponse = v.union([
  v.object({ call: v.null(), already_clear: v.literal(true) }),
  v.object({ call: LiveCall }),
]);

export type CallHangupResponse = v.InferOutput<typeof CallHangupResponse>;
