// Voice calls: browser <-> Cloudflare Realtime SFU <-> voice bridge on the Orange Pi.
//
// A single Durable Object owns the fleet's live call state. D1 holds the call log, written
// at transitions (start, answer, end) and read when someone opens the history, so
// three-second polling still never touches D1. Audio is never recorded or proxied
// through the Worker.
//
// Media flow for one call (see docs/voice-call-plan.md, "Media topology"):
//   1. dial / answer: create the browser session and publish its mic as `mic`.
//   2. connect: create the `down` adapter (SFU streams `mic` to the Pi) and the
//      `up` adapter (the Pi feeds modem audio in as `modem`), then pull `modem`
//      into the browser session. Creating the adapters is what makes the daemon
//      dial or answer, because their signed endpoint URLs carry the command.
//   3. renegotiate: apply the browser's answer to the pull offer.
//
// The browser routes are on the contract (shared/api/contract/calls.ts), which
// admits them with `messages.read`: whoever may read SMS may call. The daemon
// routes live under /api/control/, which the auth0 middleware gates with X-API-Key.

import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { parseJson, readJson } from '../../shared/parse-json.js';
import {
  closeStaleCalls,
  findOpenRing,
  insertCall,
  insertInboundRing,
  listCallHistory,
  listSimsByIccid,
  markCallAnswered,
  markCallEnded,
  setRemoteNumber,
  type OpenRingRow,
  type SimRow,
} from '../db/calls.js';
import { D1_MAX_BOUND_PARAMETERS, type D1 } from '../lib/d1.js';
import {
  type CallHistoryRow,
  IceServersResponse,
  LiveCall,
  PhoneNumber,
  SessionDescription,
  type AnswerBody,
  type CallHistoryQuery,
  type CallIdBody,
  type CallConnectResponse,
  type CallHangupResponse,
  type CallHistoryResponse,
  type CallMediaResponse,
  type CallRenegotiateResponse,
  type CallStateResponse,
  type DialBody,
  type Direction,
  type EndedCallBody,
  type EndedCallResponse,
  type IncomingCallBody,
  type IncomingCallResponse,
  type RenegotiateBody,
} from '../../shared/api/calls.js';

/** What the Durable Object answers to a read: the call and the revision it is at. */
const CallSnapshot = v.nullable(v.object({ call: LiveCall, revision: v.string() }));

/** The fields of a Realtime SFU response the bridge reads; an error is reported in a 200 too. */
const SfuBody = v.object({
  sessionId: v.optional(v.string()),
  sessionDescription: v.optional(SessionDescription),
  requiresImmediateRenegotiation: v.optional(v.boolean()),
  tracks: v.optional(
    v.array(
      v.object({
        adapterId: v.optional(v.string()),
        sessionId: v.optional(v.string()),
        errorCode: v.nullish(v.string()),
      }),
    ),
  ),
  errorCode: v.nullish(v.string()),
});

type SfuBody = v.InferOutput<typeof SfuBody>;

/** `detail` is what the SFU sent, passed to the browser as text when a step fails. */
interface SfuResult {
  ok: boolean;
  status: number;
  body: SfuBody;
  detail: unknown;
}

const Configured = v.pipe(v.string(), v.minLength(1));

/** The settings every SFU-facing route needs. */
const CallConfig = v.object({
  REALTIME_APP_ID: Configured,
  REALTIME_APP_SECRET: Configured,
  TURN_KEY_ID: Configured,
  TURN_API_TOKEN: Configured,
  VOICE_BRIDGE_HOST: Configured,
  API_KEY: Configured,
});

type CallConfig = v.InferOutput<typeof CallConfig>;

interface CallEnv {
  CALL_STATE: {
    getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> };
  };
  DB: D1<'all' | 'first' | 'run'>;
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  VOICE_BRIDGE_HOST?: string;
  API_KEY?: string;
}

/** Safety net: a wedged call disappears on its own rather than blocking the fleet. */
const CALL_TTL_SECONDS = 3600;
/**
 * A ringing call lives until the daemon stops refreshing it. The daemon reports
 * every RING (every few seconds). A missed call is also cleared explicitly by
 * /api/control/calls/ended, so the TTL is a fallback for a lost end report.
 */
const RING_TTL_SECONDS = 60;
/** How long a signed adapter endpoint stays valid; matches the call TTL. */
const ENDPOINT_TTL_SECONDS = CALL_TTL_SECONDS;
/** Track names inside the SFU: the browser microphone and the modem audio. */
const TRACK_MIC = 'mic';
const TRACK_MODEM = 'modem';

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1';
const SFU_REQUEST_TIMEOUT_MS = 15_000;
const TURN_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export function missingConfig(env: object): string[] {
  const result = v.safeParse(CallConfig, env);
  if (result.success) return [];
  return result.issues.flatMap((issue) => {
    const key = v.getDotPath(issue);
    return key === null ? [] : [key];
  });
}

/** The SFU settings; without them a call route answers 503, naming the missing ones. */
function callConfig(env: CallEnv): CallConfig {
  const result = v.safeParse(CallConfig, env);
  if (result.success) return result.output;
  throw new ORPCError('SERVICE_UNAVAILABLE', {
    message: `Voice calling is not configured: missing ${missingConfig(env).join(', ')}`,
  });
}

const revisions = new WeakMap<LiveCall, string>();
const stateUrl = 'https://call-state/';

async function readCall(env: CallEnv): Promise<LiveCall | null> {
  const response = await env.CALL_STATE.getByName('fleet').fetch(stateUrl);
  if (!response.ok) throw new Error('Could not read live call state');
  const snapshot = await readJson(response, CallSnapshot);
  if (!snapshot.ok) throw new Error(`Live call state is unreadable: ${snapshot.error}`);
  if (snapshot.value === null) return null;
  revisions.set(snapshot.value.call, snapshot.value.revision);
  return snapshot.value.call;
}

async function changeCall(
  env: CallEnv,
  expected: LiveCall | null,
  call: LiveCall | null,
  // Ignored by the Durable Object when `call` is null (a clear has no TTL).
  ttl: number = CALL_TTL_SECONDS,
): Promise<boolean> {
  const expectedRevision = expected === null ? null : revisions.get(expected);
  // A call this isolate never read has no known revision, so it cannot match.
  if (expectedRevision === undefined) return false;
  const response = await env.CALL_STATE.getByName('fleet').fetch(stateUrl, {
    method: 'POST',
    body: JSON.stringify({ expected: expectedRevision, call, ttl }),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error('Could not change live call state');
  if (call) {
    const revision = await readJson(response, v.string());
    if (!revision.ok) throw new Error(`Live call revision is unreadable: ${revision.error}`);
    revisions.set(call, revision.value);
  }
  return true;
}

function writeCall(
  env: CallEnv,
  call: LiveCall,
  ttl: number = CALL_TTL_SECONDS,
  expected: LiveCall | null = call,
): Promise<boolean> {
  return changeCall(env, expected !== null && revisions.has(expected) ? expected : null, call, ttl);
}

function clearCall(env: CallEnv, call: LiveCall): Promise<boolean> {
  return changeCall(env, call, null);
}

async function beginEnding(
  env: CallEnv,
  matches: (call: LiveCall) => boolean,
): Promise<LiveCall | null> {
  let call = await readCall(env);
  const id = call?.id;
  while (call && call.id === id && call.state !== 'ending' && matches(call)) {
    call.state = 'ending';
    if (await writeCall(env, call)) return call;
    call = await readCall(env);
  }
  return null;
}

/** The call changed under a route that was about to write it. */
function callChanged(): ORPCError<'CONFLICT', undefined> {
  return new ORPCError('CONFLICT', { message: 'No active call' });
}

/** A refusal that answers the call as it now stands. */
function conflict(
  message: string,
  call?: LiveCall,
): ORPCError<'CONFLICT', { call: LiveCall } | undefined> {
  return new ORPCError('CONFLICT', { message, data: call === undefined ? undefined : { call } });
}

export function validNumber(value: unknown): boolean {
  return v.is(PhoneNumber, value);
}

function present(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}

function isDescription(
  value: SessionDescription | undefined,
  type: SessionDescription['type'],
): value is SessionDescription {
  return value?.type === type && value.sdp !== '';
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Signed adapter endpoint the daemon verifies before it touches a modem.
 *
 * Path: /voice/{callId}/{leg}/{action}/{iccid}/{number}/{exp}/{sig}
 * sig = hex HMAC-SHA256(API_KEY, "callId\nleg\naction\niccid\nnumber\nexp").
 * The daemon already holds API_KEY, so no new shared secret is needed. The same
 * test vector lives in the daemon's tests; change both together.
 */
export async function adapterEndpoint(
  config: Pick<CallConfig, 'API_KEY' | 'VOICE_BRIDGE_HOST'>,
  {
    callId,
    leg,
    action,
    iccid,
    number,
    exp,
  }: {
    callId: string;
    leg: 'up' | 'down';
    action: 'dial' | 'answer';
    iccid: string;
    number: string | null;
    exp: number;
  },
): Promise<string> {
  const numberSegment = action === 'answer' ? '-' : (number ?? '');
  const message = [callId, leg, action, iccid, numberSegment, String(exp)].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.API_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  const segments = [callId, leg, action, iccid, numberSegment, String(exp), sig].map(
    encodeURIComponent,
  );
  return `wss://${config.VOICE_BRIDGE_HOST}/voice/${segments.join('/')}`;
}

/** SFU REST call. `body === undefined` sends no body at all, which sessions/new requires. */
async function sfu(
  config: Pick<CallConfig, 'REALTIME_APP_ID' | 'REALTIME_APP_SECRET'>,
  method: string,
  path: string,
  body?: unknown,
): Promise<SfuResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.REALTIME_APP_SECRET}`,
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(SFU_REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  let text;
  try {
    response = await fetch(`${SFU_BASE}/apps/${config.REALTIME_APP_ID}${path}`, init);
    text = await response.text();
  } catch {
    return { ok: false, status: 502, body: {}, detail: { error: 'SFU connection failed' } };
  }
  const raw = parseJson(text, v.unknown());
  const parsed = raw.ok ? v.safeParse(SfuBody, raw.value) : null;
  if (!raw.ok || !parsed?.success) {
    return {
      ok: false,
      status: response.status,
      body: {},
      detail: { error: 'Invalid SFU response', raw: text },
    };
  }
  const reply = parsed.output;
  const trackError = reply.tracks?.some((track) => present(track.errorCode)) ?? false;
  const ok = response.ok && !present(reply.errorCode) && !trackError;
  return { ok, status: response.status, body: reply, detail: raw.value };
}

/** An SFU failure, with what the SFU said, so the dashboard shows the cause. */
function sfuError(message: string, result: SfuResult): ORPCError<'BAD_GATEWAY', undefined> {
  const detail = typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail);
  console.error(`[calls] ${message}:`, detail);
  return new ORPCError('BAD_GATEWAY', { message: `${message}: ${detail}` });
}

/** Creates the browser session and publishes its mic. Returns { sessionId, answer } or { error }. */
async function publishMic(
  config: CallConfig,
  offer: { type: 'offer'; sdp: string },
  mid: string,
): Promise<
  { sessionId: string; answer: SessionDescription } | { error: ORPCError<'BAD_GATEWAY', undefined> }
> {
  const session = await sfu(config, 'POST', '/sessions/new');
  const sessionId = session.body.sessionId;
  if (!session.ok || !present(sessionId)) {
    return { error: sfuError('Could not create an SFU session', session) };
  }

  const tracks = await sfu(config, 'POST', `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: offer,
    tracks: [{ location: 'local', mid, trackName: TRACK_MIC }],
  });
  const answer = tracks.body.sessionDescription;
  if (!tracks.ok || !isDescription(answer, 'answer')) {
    return { error: sfuError('Could not publish the microphone', tracks) };
  }
  return { sessionId, answer };
}

/** Best effort, and only possible with SFU credentials: the daemon also hangs up when its WebSocket drops or the call TTL ends. */
async function closeAdapters(env: CallEnv, call: LiveCall): Promise<void> {
  const ids = [call.adapters?.up, call.adapters?.down].filter(present);
  const config = v.safeParse(CallConfig, env);
  if (ids.length === 0 || !config.success) return;
  await sfu(config.output, 'POST', '/adapters/websocket/close', {
    tracks: ids.map((adapterId) => ({ adapterId })),
  });
}

/** Ends `call` after its media failed, then answers `error`. */
async function failMedia(
  env: CallEnv,
  call: LiveCall,
  error: ORPCError<string, unknown>,
): Promise<never> {
  await closeAdapters(env, call);
  if (await clearCall(env, call)) {
    await logCallEnded(env.DB, call, { reason: 'sfu_error', endedBy: 'worker' });
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Call history (D1 `calls`, migration 077)
//
// Every write is swallowed on failure: logging must never stop a call being
// placed, answered, or — above all — hung up, because hangup is what releases
// the fleet lock. A missing history row is an annoyance; a stuck lock blocks
// the whole fleet.
// ---------------------------------------------------------------------------

/** A call cannot really last this long; a row still open lost its end report. */
const STALE_CALL_MS = 2 * 60 * 60 * 1000;
/** A ring nobody answered cannot last this long either. */
const STALE_RING_MS = 5 * 60 * 1000;

async function history(db: D1<'run'>, write: (db: D1<'run'>) => Promise<unknown>): Promise<void> {
  try {
    await write(db);
  } catch (error) {
    console.error('call history write failed', error);
  }
}

/**
 * Close rows whose end report never arrived. An unanswered ring is swept sooner
 * than a connected call: it can only have been missed, and while it stays open
 * it both hides from the log and holds this SIM's open-ring slot.
 */
function sweepStaleCalls(db: D1<'run'>, now: string): Promise<unknown> {
  return closeStaleCalls(db, {
    now,
    startedBefore: new Date(Date.now() - STALE_CALL_MS).toISOString(),
    ringStartedBefore: new Date(Date.now() - STALE_RING_MS).toISOString(),
  });
}

/**
 * Claim the log row for a ring and return whichever row is authoritative.
 *
 * Concurrent RING and caller-ID reports can both reach D1 before either claims
 * the live state. The partial unique index (migration 078) keeps one open row
 * per SIM, so both reports can use the same ID. Live state still works when
 * D1 is unavailable.
 */
async function claimRing(
  db: D1<'first' | 'run'>,
  iccid: string,
  from: string | null,
): Promise<OpenRingRow | null> {
  try {
    const now = new Date().toISOString();
    await sweepStaleCalls(db, now);
    await insertInboundRing(db, { id: crypto.randomUUID(), iccid, from, now });

    return await findOpenRing(db, iccid);
  } catch (error) {
    console.error('call history ring claim failed', error);
    return null;
  }
}

/** Open the row for a call that just started. Repeat reports must not duplicate it. */
function logCallStarted(db: D1<'run'>, call: LiveCall): Promise<void> {
  return history(db, async (log) => {
    // Sweep first: a ring whose TTL expired with no end report would otherwise
    // sit in progress forever and read as a call that never finished.
    await sweepStaleCalls(log, new Date().toISOString());

    await insertCall(log, call);
  });
}

/** A caller id that only arrived with a later RING. */
function logCallerId(db: D1<'run'>, callId: string, number: string): Promise<void> {
  return history(db, (log) => setRemoteNumber(log, callId, number));
}

/** Answer time, and for an inbound call whoever pressed answer. */
function logCallAnswered(
  db: D1<'run'>,
  callId: string,
  { at, by = null }: { at: string; by?: string | null },
): Promise<void> {
  return history(db, (log) => markCallAnswered(log, callId, at, by));
}

type EndedBy = 'dashboard' | 'daemon' | 'worker';

/**
 * What to call a call that never carried audio, once it is known who ended it.
 * `dashboard` is the operator, `daemon` the Pi, `worker` a setup failure here.
 */
export function unansweredOutcome(
  direction: Direction,
  endedBy: EndedBy,
  reason: string,
): 'failed' | 'rejected' | 'cancelled' | 'missed' {
  if (endedBy === 'worker' || reason === 'setup_failed' || reason === 'adapter_missing') {
    return 'failed';
  }
  if (endedBy === 'dashboard') return direction === 'inbound' ? 'rejected' : 'cancelled';
  return 'missed';
}

/**
 * Close the row out. Idempotent through the `in_progress` guard: the dashboard
 * and the daemon both report the end of the same call, and whoever arrives
 * first decides. Talk time comes from the row's own `answered_at`, so it is
 * right even if the live state of the call was already gone.
 */
function logCallEnded(
  db: D1<'run'>,
  call: LiveCall,
  { reason, endedBy }: { reason: string; endedBy: EndedBy },
): Promise<void> {
  return history(db, (log) => {
    const endedAt = new Date().toISOString();
    return markCallEnded(log, {
      callId: call.id,
      endedAt,
      reason,
      unansweredOutcome: unansweredOutcome(call.direction, endedBy, reason),
    });
  });
}

/** Attach each call's SIM identity, when that SIM is still in inventory. */
async function enrichCallPage(db: D1<'all'>, calls: CallHistoryRow[]) {
  const iccids = [...new Set(calls.map((call) => call.iccid).filter(present))];
  const sims = new Map<string, SimRow>();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const rows = await listSimsByIccid(db, chunk);
    for (const sim of rows) sims.set(sim.iccid, sim);
  }

  return calls.map((call) => {
    const sim = sims.get(call.iccid);
    return {
      ...call,
      sim_index: sim?.sim_index ?? null,
      sim_number: sim?.number ?? null,
      sim_carrier: sim?.carrier ?? null,
    };
  });
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

interface BrowserCall {
  env: CallEnv;
  user?: { id: string } | undefined;
}

/**
 * The browser's call routes, served through the contract with `messages.read`:
 * whoever may read SMS may call.
 */
export const callsHandler = {
  /** Current call state, for the dashboard to poll. */
  async state({ env }: BrowserCall): Promise<CallStateResponse> {
    return { call: await readCall(env) };
  },

  /**
   * The call log. Read only when someone opens the history, never on the
   * polling path, so it cannot eat the D1 row-read quota.
   */
  async history(
    { env }: BrowserCall,
    query: v.InferOutput<typeof CallHistoryQuery>,
  ): Promise<CallHistoryResponse> {
    const { DB } = env;
    const limit = boundedInt(query.limit ?? null, 30, 1, 100);
    const offset = boundedInt(query.offset ?? null, 0, 0, Number.MAX_SAFE_INTEGER);
    const iccid = query.iccid;

    // One row past the page decides `has_more` without a second COUNT query.
    // A call still in progress is excluded: the dashboard shows the live call
    // from the KV lock, and listing it here too would show it twice.
    const rows = await listCallHistory(DB, { iccid, limit: limit + 1, offset });

    const page = rows.slice(0, limit);
    return { calls: await enrichCallPage(DB, page), has_more: rows.length > limit };
  },

  /**
   * Short-lived ICE servers for the browser's PeerConnection. The TURN token
   * itself stays in the Worker; the browser only ever sees a 10-minute credential.
   */
  async ice({ env }: BrowserCall): Promise<IceServersResponse> {
    const config = callConfig(env);
    const response = await fetch(
      `${TURN_BASE}/${config.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 600 }),
      },
    );
    const text = await response.text();
    const iceServers = parseJson(text, IceServersResponse);
    if (!response.ok || !iceServers.ok) {
      console.error('[calls] Could not issue ICE servers:', text);
      throw new ORPCError('BAD_GATEWAY', { message: `Could not issue ICE servers: ${text}` });
    }
    return iceServers.value;
  },

  /** Place an outbound call: take the lock, then publish the browser mic. */
  async dial(
    { env, user }: BrowserCall,
    { iccid, number, offer, mid }: v.InferOutput<typeof DialBody>,
  ): Promise<CallMediaResponse> {
    const config = callConfig(env);

    const existing = await readCall(env);
    if (existing) throw conflict('Another call is already active', existing);

    const call: LiveCall = {
      id: crypto.randomUUID(),
      direction: 'outbound',
      state: 'connecting',
      iccid,
      number,
      started_at: new Date().toISOString(),
      requested_by: user?.id ?? null,
    };
    if (!(await writeCall(env, call))) throw conflict('Another call is already active');
    await logCallStarted(env.DB, call);

    const media = await publishMic(config, offer, mid);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) throw callChanged();
    return { call, answer: media.answer };
  },

  /** Answer the call the daemon reported as ringing. */
  async answer(
    { env, user }: BrowserCall,
    { offer, mid }: v.InferOutput<typeof AnswerBody>,
  ): Promise<CallMediaResponse> {
    const config = callConfig(env);

    const call = await readCall(env);
    if (!call) throw new ORPCError('NOT_FOUND', { message: 'No call to answer' });
    if (call.direction !== 'inbound' || call.state !== 'ringing') {
      throw conflict('Only a ringing inbound call can be answered', call);
    }

    // Take the call out of `ringing` first so a RING report cannot shorten its TTL.
    const answeredAt = new Date().toISOString();
    const answeredBy = user?.id ?? null;
    call.state = 'connecting';
    call.answered_at = answeredAt;
    call.answered_by = answeredBy;
    if (!(await writeCall(env, call))) throw callChanged();
    await logCallAnswered(env.DB, call.id, { at: answeredAt, by: answeredBy });

    const media = await publishMic(config, offer, mid);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) throw callChanged();
    return { call, answer: media.answer };
  },

  /** Bridge the browser session to the Pi. Called once the PeerConnection is up. */
  async connect(
    { env }: BrowserCall,
    { call_id: callId }: v.InferOutput<typeof CallIdBody>,
  ): Promise<CallConnectResponse> {
    const config = callConfig(env);
    const call = await readCall(env);
    if (!call || (callId !== undefined && callId !== call.id)) {
      throw new ORPCError('NOT_FOUND', { message: 'No active call' });
    }
    const sessionId = call.session_id;
    if (call.state !== 'connecting' || !present(sessionId) || call.bridge_started) {
      throw conflict('Call is not ready to connect', call);
    }
    call.bridge_started = true;
    if (!(await writeCall(env, call))) throw callChanged();

    const action = call.direction === 'outbound' ? 'dial' : 'answer';
    const exp = Math.floor(Date.now() / 1000) + ENDPOINT_TTL_SECONDS;
    const endpointFor = (leg: 'up' | 'down') =>
      adapterEndpoint(config, {
        callId: call.id,
        leg,
        action,
        iccid: call.iccid,
        number: call.number,
        exp,
      });

    // Browser mic -> Pi. Its response carries no sessionId: it reads an existing track.
    const down = await sfu(config, 'POST', '/adapters/websocket/new', {
      tracks: [
        {
          location: 'remote',
          sessionId,
          trackName: TRACK_MIC,
          endpoint: await endpointFor('down'),
          outputCodec: 'pcm',
          mode: 'stream',
        },
      ],
    });
    const downId = down.body.tracks?.[0]?.adapterId;
    if (present(downId)) call.adapters = { down: downId };
    if (!down.ok || !present(downId)) {
      return failMedia(env, call, sfuError('Could not create the outgoing audio adapter', down));
    }
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      throw callChanged();
    }

    // Pi modem audio -> SFU, published as a new track in the adapter's own session.
    const up = await sfu(config, 'POST', '/adapters/websocket/new', {
      tracks: [
        {
          location: 'local',
          trackName: TRACK_MODEM,
          endpoint: await endpointFor('up'),
          inputCodec: 'pcm',
          mode: 'buffer',
        },
      ],
    });
    const upTrack = up.body.tracks?.[0];
    const upId = upTrack?.adapterId;
    const modemSessionId = upTrack?.sessionId;
    if (present(upId)) call.adapters = { ...call.adapters, up: upId };
    if (!up.ok || !present(upId) || !present(modemSessionId)) {
      return failMedia(env, call, sfuError('Could not create the incoming audio adapter', up));
    }
    call.modem_session_id = modemSessionId;
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      throw callChanged();
    }

    const pull = await sfu(config, 'POST', `/sessions/${sessionId}/tracks/new`, {
      tracks: [{ location: 'remote', sessionId: modemSessionId, trackName: TRACK_MODEM }],
    });
    const renegotiate = pull.body.requiresImmediateRenegotiation === true;
    const offer = renegotiate ? pull.body.sessionDescription : undefined;
    if (!pull.ok || (renegotiate && !isDescription(offer, 'offer'))) {
      return failMedia(env, call, sfuError('Could not subscribe to the call audio', pull));
    }

    delete call.bridge_started;
    call.state = renegotiate ? 'bridging' : 'active';
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      throw callChanged();
    }
    if (!renegotiate) {
      // Audio is up: that is the answer moment for an outbound call. An inbound
      // call already recorded when the operator pressed answer, and COALESCE
      // keeps that earlier, truer timestamp.
      await logCallAnswered(env.DB, call.id, { at: new Date().toISOString() });
    }
    return { call, offer: offer ?? null };
  },

  /** Apply the browser's answer to the pull offer from /connect. */
  async renegotiate(
    { env }: BrowserCall,
    { answer, call_id: callId }: v.InferOutput<typeof RenegotiateBody>,
  ): Promise<CallRenegotiateResponse> {
    const config = callConfig(env);

    const call = await readCall(env);
    if (!call || (callId !== undefined && callId !== call.id)) {
      throw new ORPCError('NOT_FOUND', { message: 'No active call' });
    }
    const sessionId = call.session_id;
    if (call.state !== 'bridging' || !present(sessionId)) {
      throw conflict('Call is not waiting for renegotiation', call);
    }

    const result = await sfu(config, 'PUT', `/sessions/${sessionId}/renegotiate`, {
      sessionDescription: answer,
    });
    if (!result.ok) {
      return failMedia(env, call, sfuError('Could not renegotiate the session', result));
    }

    call.state = 'active';
    if (!(await writeCall(env, call))) throw callChanged();
    await logCallAnswered(env.DB, call.id, { at: new Date().toISOString() });
    return { call };
  },

  /** Close the adapters for the requested call, or for whichever call there is when none is named. */
  async hangup(
    { env }: BrowserCall,
    { call_id: callId }: v.InferOutput<typeof CallIdBody>,
  ): Promise<CallHangupResponse> {
    const call = await beginEnding(env, (current) => callId === undefined || current.id === callId);
    if (!call) return { call: null, already_clear: true };
    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env.DB, call, { reason: 'hangup', endedBy: 'dashboard' });

    call.state = 'ended';
    call.ended_at = new Date().toISOString();
    return { call };
  },
};

interface DaemonCall {
  env: CallEnv;
}

/** The daemon's call reports, which the contract admits with its API key. */
export const daemonCallsHandler = {
  /** A RING report: start or refresh the ringing call, unless another call holds the lock. */
  async incoming(
    { env }: DaemonCall,
    body: v.InferOutput<typeof IncomingCallBody>,
  ): Promise<IncomingCallResponse> {
    const { iccid } = body;
    const from = present(body.from) ? body.from : null;

    let existing = await readCall(env);
    const open = existing ? null : await claimRing(env.DB, iccid, from);
    for (;;) {
      if (existing && (existing.state !== 'ringing' || existing.iccid !== iccid)) {
        // The daemon expects this 409, in the body it has always read.
        throw new ORPCError('CONFLICT', {
          data: { wire: { ok: false, reason: 'another call is active' } },
        });
      }
      const knownNumber = [existing?.number, open?.remote_number].find(present) ?? null;
      const call: LiveCall = {
        id: existing?.id ?? open?.id ?? crypto.randomUUID(),
        direction: 'inbound',
        state: 'ringing',
        iccid,
        number: from ?? knownNumber,
        started_at: existing?.started_at ?? open?.started_at ?? new Date().toISOString(),
      };
      if (await writeCall(env, call, RING_TTL_SECONDS, existing)) {
        if (!existing && !open) {
          await logCallStarted(env.DB, call);
        } else if (from !== null && !present(existing?.number ?? open?.remote_number)) {
          await logCallerId(env.DB, call.id, from);
        }
        return { ok: true, call };
      }
      existing = await readCall(env);
      // An ended ring should not be revived by a refresh that was already in flight.
      if (!existing) return { ok: true, ignored: true };
    }
  },

  /** The daemon's end report: remote hangup, modem failure, or a ring that stopped. */
  async ended(
    { env }: DaemonCall,
    { call_id: callId, iccid, reason }: v.InferOutput<typeof EndedCallBody>,
  ): Promise<EndedCallResponse> {
    const call = await beginEnding(env, (current) =>
      present(callId)
        ? current.id === callId
        : current.iccid === iccid && current.state === 'ringing',
    );
    if (!call) return { ok: true, ignored: true };

    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env.DB, call, {
      reason: present(reason) ? reason.slice(0, 40) : 'ended',
      endedBy: 'daemon',
    });
    return { ok: true, call_id: call.id };
  },
};
