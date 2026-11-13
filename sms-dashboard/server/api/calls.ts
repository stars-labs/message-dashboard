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
// Browser routes authorise with `messages.read`: whoever may read SMS may call.
// Daemon routes live under /api/control/, which the auth0 middleware gates with
// X-API-Key.

import * as v from 'valibot';
import { parseJson, readJson, type Parsed } from '../../shared/parse-json.js';
import { queryAll, queryFirst, type D1 } from '../lib/d1.js';
import { OBJECT_MESSAGE, readBody, type MissingKeyMessages } from '../lib/request-body.js';
import { handleAuth0, type AuthRequest } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';

const DIRECTIONS = ['inbound', 'outbound'] as const;
const CALL_STATES = ['ringing', 'connecting', 'bridging', 'active', 'ending', 'ended'] as const;
const ENDED_OUTCOMES = ['answered', 'missed', 'rejected', 'cancelled', 'failed'] as const;

type Direction = (typeof DIRECTIONS)[number];

/** The live call record the fleet Durable Object holds. */
const LiveCall = v.object({
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

type LiveCall = v.InferOutput<typeof LiveCall>;

/** What the Durable Object answers to a read: the call and the revision it is at. */
const CallSnapshot = v.nullable(v.object({ call: LiveCall, revision: v.string() }));

/** The fields of a Realtime SFU response the bridge reads; an error is reported in a 200 too. */
const SfuBody = v.object({
  sessionId: v.optional(v.string()),
  sessionDescription: v.optional(
    v.object({ type: v.picklist(['offer', 'answer']), sdp: v.string() }),
  ),
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
type SessionDescription = NonNullable<SfuBody['sessionDescription']>;

/** `detail` is what the SFU sent, passed to the browser when a step fails. */
interface SfuResult {
  ok: boolean;
  status: number;
  body: SfuBody;
  detail: unknown;
}

const IceServers = v.object({
  iceServers: v.array(
    v.object({
      urls: v.union([v.string(), v.array(v.string())]),
      username: v.optional(v.string()),
      credential: v.optional(v.string()),
    }),
  ),
});

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

interface CallRequest extends AuthRequest {
  env: AuthRequest['env'] & CallEnv;
  body: ReadableStream | null;
  text(): Promise<string>;
}

type CallHandler = (request: CallRequest) => Promise<Response>;

interface Router {
  get(path: string, handler: CallHandler): void;
  post(path: string, handler: CallHandler): void;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Auth0 + RBAC gate. Returns a Response to short-circuit, or null to proceed. */
async function gate(request: CallRequest): Promise<Response | null> {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('messages.read')(request);
  if (permResponse) return permResponse;
  return null;
}

export function missingConfig(env: object): string[] {
  const result = v.safeParse(CallConfig, env);
  if (result.success) return [];
  return result.issues.flatMap((issue) => {
    const key = v.getDotPath(issue);
    return key === null ? [] : [key];
  });
}

/** The SFU settings, or the 503 that names the missing ones. */
function callConfig(env: CallEnv): CallConfig | Response {
  const result = v.safeParse(CallConfig, env);
  if (result.success) return result.output;
  return json(
    {
      error: 'Voice calling is not configured',
      detail: `missing ${missingConfig(env).join(', ')}`,
    },
    503,
  );
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

function callChanged(): Response {
  return json({ error: 'No active call' }, 409);
}

const ICCID_MESSAGE = 'iccid is required';
const NUMBER_MESSAGE = 'number must be E.164, for example +6591234567';
const MEDIA_MESSAGE = 'offer and mid are required';
const ANSWER_MESSAGE = 'answer is required';
const CALL_ID_MESSAGE = 'Invalid call ID';

/**
 * E.164 only. The SMS sender already refuses anything else for ordinary sends,
 * and a dialer is a place where a loose pattern turns a typo into a wrong number.
 */
const PhoneNumber = v.pipe(v.string(NUMBER_MESSAGE), v.regex(/^\+[1-9]\d{6,14}$/, NUMBER_MESSAGE));

export function validNumber(value: unknown): boolean {
  return v.is(PhoneNumber, value);
}

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

const DialBody = v.object(
  {
    iccid: v.pipe(v.string(ICCID_MESSAGE), v.regex(/^[0-9A-Fa-f]{18,22}$/, ICCID_MESSAGE)),
    number: PhoneNumber,
    offer: sessionDescriptionBody('offer', MEDIA_MESSAGE),
    mid: Mid,
  },
  OBJECT_MESSAGE,
);

const DIAL_MISSING_KEY_MESSAGES = {
  iccid: ICCID_MESSAGE,
  number: NUMBER_MESSAGE,
  offer: MEDIA_MESSAGE,
  mid: MEDIA_MESSAGE,
} as const satisfies MissingKeyMessages<typeof DialBody>;

const AnswerBody = v.object(
  { offer: sessionDescriptionBody('offer', MEDIA_MESSAGE), mid: Mid },
  OBJECT_MESSAGE,
);

const ANSWER_MISSING_KEY_MESSAGES = {
  offer: MEDIA_MESSAGE,
  mid: MEDIA_MESSAGE,
} as const satisfies MissingKeyMessages<typeof AnswerBody>;

const CallIdBody = v.object({ call_id: CallId }, OBJECT_MESSAGE);

const RenegotiateBody = v.object(
  { answer: sessionDescriptionBody('answer', ANSWER_MESSAGE), call_id: CallId },
  OBJECT_MESSAGE,
);

const RENEGOTIATE_MISSING_KEY_MESSAGES = {
  answer: ANSWER_MESSAGE,
} as const satisfies MissingKeyMessages<typeof RenegotiateBody>;

/** The daemon's RING report: `from` is null until the network sends a caller id. */
const IncomingBody = v.object(
  {
    iccid: v.pipe(v.string(ICCID_MESSAGE), v.minLength(1, ICCID_MESSAGE)),
    from: v.nullish(v.string('from must be a string')),
  },
  OBJECT_MESSAGE,
);

const INCOMING_MISSING_KEY_MESSAGES = {
  iccid: ICCID_MESSAGE,
} as const satisfies MissingKeyMessages<typeof IncomingBody>;

/** The daemon's end report: `call_id` is null for a ring that stopped unanswered. */
const EndedBody = v.pipe(
  v.object(
    {
      call_id: v.nullish(v.string(CALL_ID_MESSAGE)),
      iccid: v.nullish(v.string('iccid must be a string')),
      reason: v.nullish(v.string('reason must be a string')),
    },
    OBJECT_MESSAGE,
  ),
  v.check(
    ({ call_id, iccid }) => (call_id ?? '') !== '' || (iccid ?? '') !== '',
    'call_id or iccid is required',
  ),
);

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

function sfuError(message: string, result: SfuResult): Response {
  return json({ error: message, detail: result.detail }, 502);
}

/** Creates the browser session and publishes its mic. Returns { sessionId, answer } or { error }. */
async function publishMic(
  config: CallConfig,
  offer: { type: 'offer'; sdp: string },
  mid: string,
): Promise<{ sessionId: string; answer: SessionDescription } | { error: Response }> {
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

async function failMedia(env: CallEnv, call: LiveCall, response: Response): Promise<Response> {
  await closeAdapters(env, call);
  if (await clearCall(env, call)) {
    await logCallEnded(env.DB, call, { reason: 'sfu_error', endedBy: 'worker' });
  }
  return response;
}

/** A route whose body is optional reads a request without one as `{}`. */
function readCallIdBody(request: CallRequest): Promise<Parsed<v.InferOutput<typeof CallIdBody>>> {
  return request.body === null
    ? Promise.resolve({ ok: true, value: {} })
    : readBody(request, CallIdBody, {});
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

/** D1 rejects a statement with more bound parameters than this. */
const D1_MAX_BOUND_PARAMETERS = 100;

const HISTORY_COLUMNS = `id, direction, iccid, remote_number, outcome, end_reason,
         started_at, answered_at, ended_at, duration_seconds, requested_by, answered_by`;

/** A finished call; the history query never selects one still in progress. */
const CallHistoryRow = v.object({
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

type CallHistoryRow = v.InferOutput<typeof CallHistoryRow>;

const OpenRingRow = v.object({
  id: v.string(),
  started_at: v.string(),
  remote_number: v.nullable(v.string()),
});

type OpenRingRow = v.InferOutput<typeof OpenRingRow>;

const SimRow = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  sim_index: v.number(),
});

type SimRow = v.InferOutput<typeof SimRow>;

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
  return db
    .prepare(
      `UPDATE calls
        SET outcome = CASE WHEN answered_at IS NULL THEN 'missed' ELSE 'failed' END,
            end_reason = 'stale',
            ended_at = COALESCE(ended_at, ?)
      WHERE outcome = 'in_progress'
        AND (started_at < ? OR (answered_at IS NULL AND started_at < ?))`,
    )
    .bind(
      now,
      new Date(Date.now() - STALE_CALL_MS).toISOString(),
      new Date(Date.now() - STALE_RING_MS).toISOString(),
    )
    .run();
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
    await db
      .prepare(
        `INSERT OR IGNORE INTO calls (id, direction, iccid, remote_number, outcome, started_at)
       VALUES (?, 'inbound', ?, ?, 'in_progress', ?)`,
      )
      .bind(crypto.randomUUID(), iccid, from, now)
      .run();

    return await queryFirst(
      db
        .prepare(
          `SELECT id, started_at, remote_number
         FROM calls
        WHERE iccid = ? AND direction = 'inbound' AND outcome = 'in_progress'
          AND answered_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
        )
        .bind(iccid),
      OpenRingRow,
    );
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

    await log
      .prepare(
        `INSERT INTO calls (id, direction, iccid, remote_number, outcome, started_at, requested_by)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        call.id,
        call.direction,
        call.iccid,
        call.number,
        call.started_at,
        call.requested_by ?? null,
      )
      .run();
  });
}

/** A caller id that only arrived with a later RING. */
function logCallerId(db: D1<'run'>, callId: string, number: string): Promise<void> {
  return history(db, (log) =>
    log
      .prepare(`UPDATE calls SET remote_number = ? WHERE id = ? AND remote_number IS NULL`)
      .bind(number, callId)
      .run(),
  );
}

/** Answer time, and for an inbound call whoever pressed answer. */
function logCallAnswered(
  db: D1<'run'>,
  callId: string,
  { at, by = null }: { at: string; by?: string | null },
): Promise<void> {
  return history(db, (log) =>
    log
      .prepare(
        `UPDATE calls
        SET answered_at = COALESCE(answered_at, ?), answered_by = COALESCE(answered_by, ?)
      WHERE id = ? AND outcome = 'in_progress'`,
      )
      .bind(at, by, callId)
      .run(),
  );
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
    return log
      .prepare(
        `UPDATE calls
          SET ended_at = ?,
              end_reason = ?,
              duration_seconds = CASE
                WHEN answered_at IS NULL THEN 0
                ELSE MAX(0, CAST((julianday(?) - julianday(answered_at)) * 86400 AS INTEGER))
              END,
              outcome = CASE WHEN answered_at IS NULL THEN ? ELSE 'answered' END
        WHERE id = ? AND outcome = 'in_progress'`,
      )
      .bind(endedAt, reason, endedAt, unansweredOutcome(call.direction, endedBy, reason), call.id)
      .run();
  });
}

/** Attach each call's SIM identity, when that SIM is still in inventory. */
async function enrichCallPage(db: D1<'all'>, calls: CallHistoryRow[]) {
  const iccids = [...new Set(calls.map((call) => call.iccid).filter(present))];
  const sims = new Map<string, SimRow>();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await queryAll(
      db
        .prepare(
          `SELECT iccid, number, carrier, sim_index FROM device_view WHERE iccid IN (${placeholders})`,
        )
        .bind(...chunk),
      SimRow,
    );
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

export function setupCallRoutes(router: Router): void {
  // Current call state, for the dashboard to poll.
  router.get('/api/calls/state', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    return json({ call: await readCall(request.env) });
  });

  // The call log. Read only when someone opens the history — never on the
  // polling path — so it cannot eat the D1 row-read quota.
  router.get('/api/calls/history', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    const { DB } = request.env;

    const url = new URL(request.url);
    const limit = boundedInt(url.searchParams.get('limit'), 30, 1, 100);
    const offset = boundedInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const iccid = url.searchParams.get('iccid');

    // One row past the page decides `has_more` without a second COUNT query.
    // A call still in progress is excluded: the dashboard shows the live call
    // from the KV lock, and listing it here too would show it twice.
    const binds = iccid ? [iccid, limit + 1, offset] : [limit + 1, offset];
    const rows = await queryAll(
      DB.prepare(
        `SELECT ${HISTORY_COLUMNS}
         FROM calls
        WHERE outcome != 'in_progress'${iccid ? ' AND iccid = ?' : ''}
        ORDER BY started_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      ).bind(...binds),
      CallHistoryRow,
    );

    const page = rows.slice(0, limit);
    return json({ calls: await enrichCallPage(DB, page), has_more: rows.length > limit });
  });

  // Short-lived ICE servers for the browser's PeerConnection. The TURN token
  // itself stays in the Worker; the browser only ever sees a 10-minute credential.
  router.get('/api/calls/ice', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    const config = callConfig(request.env);
    if (config instanceof Response) return config;

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
    const iceServers = parseJson(text, IceServers);
    if (!response.ok || !iceServers.ok) {
      return json({ error: 'Could not issue ICE servers', detail: text }, 502);
    }
    return json(iceServers.value);
  });

  // Place an outbound call: take the lock, then publish the browser mic.
  router.post('/api/calls/dial', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    const { env } = request;
    const config = callConfig(env);
    if (config instanceof Response) return config;

    const parsed = await readBody(request, DialBody, DIAL_MISSING_KEY_MESSAGES);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { iccid, number, offer, mid } = parsed.value;

    const existing = await readCall(env);
    if (existing) return json({ error: 'Another call is already active', call: existing }, 409);

    const call: LiveCall = {
      id: crypto.randomUUID(),
      direction: 'outbound',
      state: 'connecting',
      iccid,
      number,
      started_at: new Date().toISOString(),
      requested_by: request.user?.id ?? null,
    };
    if (!(await writeCall(env, call)))
      return json({ error: 'Another call is already active' }, 409);
    await logCallStarted(env.DB, call);

    const media = await publishMic(config, offer, mid);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) return callChanged();
    return json({ call, answer: media.answer });
  });

  // Answer the call the daemon reported as ringing.
  router.post('/api/calls/answer', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    const { env } = request;
    const config = callConfig(env);
    if (config instanceof Response) return config;

    const parsed = await readBody(request, AnswerBody, ANSWER_MISSING_KEY_MESSAGES);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { offer, mid } = parsed.value;

    const call = await readCall(env);
    if (!call) return json({ error: 'No call to answer' }, 404);
    if (call.direction !== 'inbound' || call.state !== 'ringing') {
      return json({ error: 'Only a ringing inbound call can be answered', call }, 409);
    }

    // Take the call out of `ringing` first so a RING report cannot shorten its TTL.
    const answeredAt = new Date().toISOString();
    const answeredBy = request.user?.id ?? null;
    call.state = 'connecting';
    call.answered_at = answeredAt;
    call.answered_by = answeredBy;
    if (!(await writeCall(env, call))) return callChanged();
    await logCallAnswered(env.DB, call.id, { at: answeredAt, by: answeredBy });

    const media = await publishMic(config, offer, mid);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) return callChanged();
    return json({ call, answer: media.answer });
  });

  // Bridge the browser session to the Pi. Called once the PeerConnection is up.
  router.post('/api/calls/connect', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    const { env } = request;
    const config = callConfig(env);
    if (config instanceof Response) return config;

    const parsed = await readCallIdBody(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { call_id: callId } = parsed.value;
    const call = await readCall(env);
    if (!call || (callId !== undefined && callId !== call.id)) {
      return json({ error: 'No active call' }, 404);
    }
    const sessionId = call.session_id;
    if (call.state !== 'connecting' || !present(sessionId) || call.bridge_started) {
      return json({ error: 'Call is not ready to connect', call }, 409);
    }
    call.bridge_started = true;
    if (!(await writeCall(env, call))) return callChanged();

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
      return callChanged();
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
      return callChanged();
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
      return callChanged();
    }
    if (!renegotiate) {
      // Audio is up: that is the answer moment for an outbound call. An inbound
      // call already recorded when the operator pressed answer, and COALESCE
      // keeps that earlier, truer timestamp.
      await logCallAnswered(env.DB, call.id, { at: new Date().toISOString() });
    }
    return json({ call, offer: offer ?? null });
  });

  // Apply the browser's answer to the pull offer from /connect.
  router.post('/api/calls/renegotiate', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    const { env } = request;
    const config = callConfig(env);
    if (config instanceof Response) return config;

    const parsed = await readBody(request, RenegotiateBody, RENEGOTIATE_MISSING_KEY_MESSAGES);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { answer, call_id: callId } = parsed.value;

    const call = await readCall(env);
    if (!call || (callId !== undefined && callId !== call.id)) {
      return json({ error: 'No active call' }, 404);
    }
    const sessionId = call.session_id;
    if (call.state !== 'bridging' || !present(sessionId)) {
      return json({ error: 'Call is not waiting for renegotiation', call }, 409);
    }

    const result = await sfu(config, 'PUT', `/sessions/${sessionId}/renegotiate`, {
      sessionDescription: answer,
    });
    if (!result.ok) {
      return failMedia(env, call, sfuError('Could not renegotiate the session', result));
    }

    call.state = 'active';
    if (!(await writeCall(env, call))) return callChanged();
    await logCallAnswered(env.DB, call.id, { at: new Date().toISOString() });
    return json({ call });
  });

  // Close the adapters for the requested call. Older clients omit the ID.
  router.post('/api/calls/hangup', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;
    const { env } = request;

    const parsed = await readCallIdBody(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { call_id: callId } = parsed.value;
    const call = await beginEnding(env, (current) => callId === undefined || current.id === callId);
    if (!call) {
      return json({ call: null, already_clear: true });
    }
    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env.DB, call, { reason: 'hangup', endedBy: 'dashboard' });

    call.state = 'ended';
    call.ended_at = new Date().toISOString();
    return json({ call });
  });

  // Daemon-reported incoming call, repeated on every RING to keep it alive.
  router.post('/api/control/calls/incoming', async (request) => {
    const authResponse = await handleAuth0(request);
    if (authResponse) return authResponse;
    const { env } = request;

    const parsed = await readBody(request, IncomingBody, INCOMING_MISSING_KEY_MESSAGES);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { iccid } = parsed.value;
    const from = present(parsed.value.from) ? parsed.value.from : null;

    let existing = await readCall(env);
    const open = existing ? null : await claimRing(env.DB, iccid, from);
    for (;;) {
      if (existing && (existing.state !== 'ringing' || existing.iccid !== iccid)) {
        return json({ ok: false, reason: 'another call is active' }, 409);
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
        return json({ ok: true, call });
      }
      existing = await readCall(env);
      // An ended ring should not be revived by a refresh that was already in flight.
      if (!existing) return json({ ok: true, ignored: true });
    }
  });

  // Daemon-reported end: remote hangup, modem failure, or a ring that stopped.
  router.post('/api/control/calls/ended', async (request) => {
    const authResponse = await handleAuth0(request);
    if (authResponse) return authResponse;
    const { env } = request;

    const parsed = await readBody(request, EndedBody, {});
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { call_id: callId, iccid, reason } = parsed.value;

    const call = await beginEnding(env, (current) =>
      present(callId)
        ? current.id === callId
        : current.iccid === iccid && current.state === 'ringing',
    );
    if (!call) return json({ ok: true, ignored: true });

    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env.DB, call, {
      reason: present(reason) ? reason.slice(0, 40) : 'ended',
      endedBy: 'daemon',
    });
    return json({ ok: true, call_id: call.id });
  });
}
