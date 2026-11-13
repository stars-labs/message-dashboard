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

import { handleAuth0 } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import type { AppRequest, Env, Handler } from '../worker-context.js';
import type { ExecutionContext, D1Database } from '../cf-bindings.js';
import type { Permission } from '../../config/auth0-roles.js';

/** The router shape setupCallRoutes needs. */
interface Router {
  get(path: string, ...handlers: Handler[]): void;
  post(path: string, ...handlers: Handler[]): void;
}

/** The live call record the fleet Durable Object holds. */
interface LiveCall {
  id: string;
  direction: 'inbound' | 'outbound';
  state: 'ringing' | 'connecting' | 'bridging' | 'active' | 'ending' | 'ended';
  iccid?: string;
  number?: string | null;
  started_at?: string;
  requested_by?: string | null;
  answered_at?: string;
  answered_by?: string | null;
  session_id?: string;
  modem_session_id?: string;
  bridge_started?: boolean;
  ended_at?: string;
  adapters?: { up?: string; down?: string };
  [field: string]: unknown;
}

/** The call-state snapshot the Durable Object returns. */
interface CallSnapshot {
  call: LiveCall;
  revision: number;
}

/** WebRTC session description, as the SFU and the browser exchange it. */
interface SessionDescription {
  type: string;
  sdp: string;
}

interface SfuResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> & {
    errorCode?: unknown;
    tracks?: Array<{ adapterId?: string; sessionId?: string; errorCode?: unknown }>;
    sessionId?: string;
    sessionDescription?: SessionDescription;
    requiresImmediateRenegotiation?: unknown;
    error?: unknown;
  };
}

/** What readJson returns: anything JSON-shaped, or null when the body is not JSON. */
type JsonBody = Record<string, unknown>;

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
async function gate(
  request: AppRequest,
  env: Env,
  ctx: ExecutionContext,
  permission: Permission = 'messages.read',
): Promise<Response | null> {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request);
  const permResponse = await requirePermission(permission)(request, env, ctx);
  if (permResponse) return permResponse;
  return null;
}

export function missingConfig(env: Env): string[] {
  const needed = [
    'REALTIME_APP_ID',
    'REALTIME_APP_SECRET',
    'TURN_KEY_ID',
    'TURN_API_TOKEN',
    'VOICE_BRIDGE_HOST',
    'API_KEY',
  ];
  return needed.filter((k) => !env[k as keyof Env]);
}

function notConfigured(env: Env): Response | null {
  const missing = missingConfig(env);
  if (!missing.length) return null;
  return json(
    { error: 'Voice calling is not configured', detail: `missing ${missing.join(', ')}` },
    503,
  );
}

const revisions = new WeakMap<LiveCall, number>();
const stateUrl = 'https://call-state/';

async function readCall(env: Env): Promise<LiveCall | null> {
  const response = await env.CALL_STATE.getByName('fleet').fetch(stateUrl);
  if (!response.ok) throw new Error('Could not read live call state');
  const snapshot = (await response.json()) as CallSnapshot | null;
  if (!snapshot) return null;
  revisions.set(snapshot.call, snapshot.revision);
  return snapshot.call;
}

async function changeCall(
  env: Env,
  expected: LiveCall | null,
  call: LiveCall | null,
  // Ignored by the Durable Object when `call` is null (a clear has no TTL).
  ttl: number = CALL_TTL_SECONDS,
): Promise<boolean> {
  const response = await env.CALL_STATE.getByName('fleet').fetch(stateUrl, {
    method: 'POST',
    body: JSON.stringify({ expected: expected ? revisions.get(expected) : null, call, ttl }),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error('Could not change live call state');
  if (call) revisions.set(call, (await response.json()) as number);
  return true;
}

function writeCall(
  env: Env,
  call: LiveCall,
  ttl: number = CALL_TTL_SECONDS,
  expected: LiveCall | null = call,
): Promise<boolean> {
  return changeCall(env, expected && revisions.has(expected) ? expected : null, call, ttl);
}

function clearCall(env: Env, call: LiveCall): Promise<boolean> {
  return changeCall(env, call, null);
}

async function beginEnding(
  env: Env,
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

/**
 * E.164 only. The SMS sender already refuses anything else for ordinary sends,
 * and a dialer is a place where a loose pattern turns a typo into a wrong number.
 */
export function validNumber(value: unknown): boolean {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
}

function validIccid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9A-Fa-f]{18,22}$/.test(value);
}

function validDescription(value: unknown, type: string): value is SessionDescription {
  const v = value as { type?: unknown; sdp?: unknown } | null | undefined;
  return Boolean(v && v.type === type && typeof v.sdp === 'string' && v.sdp);
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
  env: Env,
  {
    callId,
    leg,
    action,
    iccid,
    number,
    exp,
  }: {
    callId: string;
    leg: string;
    action: 'dial' | 'answer';
    iccid: string;
    number: string | null | undefined;
    exp: number;
  },
): Promise<string> {
  const numberSegment = action === 'answer' ? '-' : number;
  const message = [callId, leg, action, iccid, numberSegment, String(exp)].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.API_KEY ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  const segments = [callId, leg, action, iccid, numberSegment ?? '', String(exp), sig].map(
    encodeURIComponent,
  );
  return `wss://${env.VOICE_BRIDGE_HOST}/voice/${segments.join('/')}`;
}

/** SFU REST call. `body === undefined` sends no body at all, which sessions/new requires. */
async function sfu(env: Env, method: string, path: string, body?: unknown): Promise<SfuResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${env.REALTIME_APP_SECRET}` };
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
    response = await fetch(`${SFU_BASE}/apps/${env.REALTIME_APP_ID}${path}`, init);
    text = await response.text();
  } catch {
    return { ok: false, status: 502, body: { error: 'SFU connection failed' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  // The SFU reports per-track failures inside a 200 as well as at the top level.
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    ((parsed as SfuResult['body']).tracks !== undefined &&
      !Array.isArray((parsed as SfuResult['body']).tracks))
  ) {
    return { ok: false, status: response.status, body: { error: 'Invalid SFU response' } };
  }
  const p = parsed as SfuResult['body'];
  const trackError = p.tracks?.some((track) => !track || track.errorCode);
  const ok = response.ok && !p.errorCode && !trackError;
  return { ok, status: response.status, body: p };
}

function sfuError(message: string, result: SfuResult): Response {
  return json({ error: message, detail: result.body }, 502);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Creates the browser session and publishes its mic. Returns { sessionId, answer } or { error }. */
async function publishMic(
  env: Env,
  offer: SessionDescription,
  mid: string,
): Promise<{ sessionId: string; answer: SessionDescription } | { error: Response }> {
  const session = await sfu(env, 'POST', '/sessions/new');
  if (!session.ok || !validId(session.body.sessionId)) {
    return { error: sfuError('Could not create an SFU session', session) };
  }
  const sessionId = session.body.sessionId;

  const tracks = await sfu(env, 'POST', `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: offer,
    tracks: [{ location: 'local', mid, trackName: TRACK_MIC }],
  });
  if (!tracks.ok || !validDescription(tracks.body.sessionDescription, 'answer')) {
    return { error: sfuError('Could not publish the microphone', tracks) };
  }
  return { sessionId, answer: tracks.body.sessionDescription };
}

async function closeAdapters(env: Env, call: LiveCall | null): Promise<void> {
  const ids = [call?.adapters?.up, call?.adapters?.down].filter((id): id is string => Boolean(id));
  if (!ids.length) return;
  try {
    await sfu(env, 'POST', '/adapters/websocket/close', {
      tracks: ids.map((adapterId) => ({ adapterId })),
    });
  } catch {
    // Best effort: the daemon also hangs up when its WebSocket drops or the call TTL ends.
  }
}

async function failMedia(env: Env, call: LiveCall, response: Response): Promise<Response> {
  await closeAdapters(env, call);
  if (await clearCall(env, call)) {
    await logCallEnded(env, call, { reason: 'sfu_error', endedBy: 'worker' });
  }
  return response;
}

async function readJson(request: AppRequest): Promise<JsonBody | null> {
  try {
    return ((await request.json()) as JsonBody) || {};
  } catch {
    return null;
  }
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

async function history(env: Env, write: (db: D1Database) => Promise<unknown>): Promise<void> {
  if (!env.DB) return;
  try {
    await write(env.DB);
  } catch (error) {
    console.error('call history write failed', error);
  }
}

/**
 * Close rows whose end report never arrived. An unanswered ring is swept sooner
 * than a connected call: it can only have been missed, and while it stays open
 * it both hides from the log and holds this SIM's open-ring slot.
 */
function sweepStaleCalls(db: D1Database, now: string): Promise<unknown> {
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
  env: Env,
  iccid: string,
  from: unknown,
): Promise<{ id: string; started_at: string; remote_number: string | null } | null> {
  if (!env.DB) return null;
  try {
    const now = new Date().toISOString();
    await sweepStaleCalls(env.DB, now);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO calls (id, direction, iccid, remote_number, outcome, started_at)
       VALUES (?, 'inbound', ?, ?, 'in_progress', ?)`,
    )
      .bind(crypto.randomUUID(), iccid, from ?? null, now)
      .run();

    const row = await env.DB.prepare(
      `SELECT id, started_at, remote_number
         FROM calls
        WHERE iccid = ? AND direction = 'inbound' AND outcome = 'in_progress'
          AND answered_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
    )
      .bind(iccid)
      .first<{ id: string; started_at: string; remote_number: string | null }>();
    return row ?? null;
  } catch (error) {
    console.error('call history ring claim failed', error);
    return null;
  }
}

/** Open the row for a call that just started. Repeat reports must not duplicate it. */
function logCallStarted(env: Env, call: LiveCall): Promise<void> {
  return history(env, async (db) => {
    // Sweep first: a ring whose TTL expired with no end report would otherwise
    // sit in progress forever and read as a call that never finished.
    await sweepStaleCalls(db, new Date().toISOString());

    await db
      .prepare(
        `INSERT INTO calls (id, direction, iccid, remote_number, outcome, started_at, requested_by)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        call.id,
        call.direction,
        call.iccid,
        call.number ?? null,
        call.started_at,
        call.requested_by ?? null,
      )
      .run();
  });
}

/** A caller id that only arrived with a later RING. */
function logCallerId(env: Env, callId: string, number: string): Promise<void> {
  return history(env, (db) =>
    db
      .prepare(`UPDATE calls SET remote_number = ? WHERE id = ? AND remote_number IS NULL`)
      .bind(number, callId)
      .run(),
  );
}

/** Answer time, and for an inbound call whoever pressed answer. */
function logCallAnswered(
  env: Env,
  callId: string,
  { at, by = null }: { at: string; by?: string | null },
): Promise<void> {
  return history(env, (db) =>
    db
      .prepare(
        `UPDATE calls
        SET answered_at = COALESCE(answered_at, ?), answered_by = COALESCE(answered_by, ?)
      WHERE id = ? AND outcome = 'in_progress'`,
      )
      .bind(at, by, callId)
      .run(),
  );
}

/**
 * What to call a call that never carried audio, once it is known who ended it.
 * `dashboard` is the operator, `daemon` the Pi, `worker` a setup failure here.
 */
export function unansweredOutcome(
  direction: string | undefined,
  endedBy: string,
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
  env: Env,
  call: LiveCall,
  { reason, endedBy }: { reason: string; endedBy: 'dashboard' | 'daemon' | 'worker' },
): Promise<void> {
  return history(env, (db) => {
    const endedAt = new Date().toISOString();
    return db
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
async function enrichCallPage(db: D1Database, calls: Array<Record<string, unknown>>) {
  const iccids = [
    ...new Set(
      calls
        .map((call) => call.iccid)
        .filter((iccid): iccid is string => typeof iccid === 'string' && !!iccid),
    ),
  ];
  const sims = new Map<
    string,
    { iccid: string; number: string | null; carrier: string | null; sim_index: number | null }
  >();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `SELECT iccid, number, carrier, sim_index FROM device_view WHERE iccid IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<{
        iccid: string;
        number: string | null;
        carrier: string | null;
        sim_index: number | null;
      }>();
    for (const sim of result.results) sims.set(sim.iccid, sim);
  }

  return calls.map((call) => {
    const sim = typeof call.iccid === 'string' ? sims.get(call.iccid) : undefined;
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
  router.get('/api/calls/state', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    return json({ call: await readCall(env) });
  });

  // The call log. Read only when someone opens the history — never on the
  // polling path — so it cannot eat the D1 row-read quota.
  router.get('/api/calls/history', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    if (!env.DB) return json({ calls: [], has_more: false });

    const url = new URL(request.url);
    const limit = boundedInt(url.searchParams.get('limit'), 30, 1, 100);
    const offset = boundedInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const iccid = url.searchParams.get('iccid');

    // One row past the page decides `has_more` without a second COUNT query.
    // A call still in progress is excluded: the dashboard shows the live call
    // from the KV lock, and listing it here too would show it twice.
    const binds = iccid ? [iccid, limit + 1, offset] : [limit + 1, offset];
    const { results } = await env.DB.prepare(
      `SELECT ${HISTORY_COLUMNS}
         FROM calls
        WHERE outcome != 'in_progress'${iccid ? ' AND iccid = ?' : ''}
        ORDER BY started_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...binds)
      .all<Record<string, unknown>>();

    const rows = results;
    const page = rows.slice(0, limit);
    return json({ calls: await enrichCallPage(env.DB, page), has_more: rows.length > limit });
  });

  // Short-lived ICE servers for the browser's PeerConnection. The TURN token
  // itself stays in the Worker; the browser only ever sees a 10-minute credential.
  router.get('/api/calls/ice', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const response = await fetch(
      `${TURN_BASE}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 600 }),
      },
    );
    if (!response.ok)
      return json({ error: 'Could not issue ICE servers', detail: await response.text() }, 502);
    return json(await response.json());
  });

  // Place an outbound call: take the lock, then publish the browser mic.
  router.post('/api/calls/dial', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { iccid, number, offer, mid } = body;
    if (!validIccid(iccid)) return json({ error: 'iccid is required' }, 400);
    if (!validNumber(number))
      return json({ error: 'number must be E.164, for example +6591234567' }, 400);
    if (!validDescription(offer, 'offer') || !validId(mid))
      return json({ error: 'offer and mid are required' }, 400);

    const existing = await readCall(env);
    if (existing) return json({ error: 'Another call is already active', call: existing }, 409);

    const call: LiveCall = {
      id: crypto.randomUUID(),
      direction: 'outbound',
      state: 'connecting',
      iccid: iccid as string,
      number: number as string,
      started_at: new Date().toISOString(),
      // The KV session stores the raw Auth0 user (`sub`); the JWT middleware
      // builds `id`. Accept either, as the original did.
      requested_by: request.user?.id ?? request.user?.sub ?? null,
    };
    if (!(await writeCall(env, call)))
      return json({ error: 'Another call is already active' }, 409);
    await logCallStarted(env, call);

    const media = await publishMic(env, offer, mid);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) return callChanged();
    return json({ call, answer: media.answer });
  });

  // Answer the call the daemon reported as ringing.
  router.post('/api/calls/answer', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { offer, mid } = body;
    if (!validDescription(offer, 'offer') || !validId(mid))
      return json({ error: 'offer and mid are required' }, 400);

    const call = await readCall(env);
    if (!call) return json({ error: 'No call to answer' }, 404);
    if (call.direction !== 'inbound' || call.state !== 'ringing') {
      return json({ error: 'Only a ringing inbound call can be answered', call }, 409);
    }

    // Take the call out of `ringing` first so a RING report cannot shorten its TTL.
    call.state = 'connecting';
    call.answered_at = new Date().toISOString();
    call.answered_by = request.user?.id ?? request.user?.sub ?? null;
    if (!(await writeCall(env, call))) return callChanged();
    await logCallAnswered(env, call.id, { at: call.answered_at, by: call.answered_by });

    const media = await publishMic(env, offer, mid as string);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) return callChanged();
    return json({ call, answer: media.answer });
  });

  // Bridge the browser session to the Pi. Called once the PeerConnection is up.
  router.post('/api/calls/connect', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const body = request.body === null ? {} : await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const call = await readCall(env);
    if (!call || (body.call_id !== undefined && body.call_id !== call.id)) {
      return json({ error: 'No active call' }, 404);
    }
    if (call.state !== 'connecting' || !call.session_id || call.bridge_started) {
      return json({ error: 'Call is not ready to connect', call }, 409);
    }
    call.bridge_started = true;
    if (!(await writeCall(env, call))) return callChanged();

    const action = call.direction === 'outbound' ? 'dial' : 'answer';
    const exp = Math.floor(Date.now() / 1000) + ENDPOINT_TTL_SECONDS;
    const endpointFor = (leg: string) =>
      adapterEndpoint(env, {
        callId: call.id,
        leg,
        action,
        iccid: call.iccid ?? '',
        number: call.number,
        exp,
      });

    // Browser mic -> Pi. Its response carries no sessionId: it reads an existing track.
    const down = await sfu(env, 'POST', '/adapters/websocket/new', {
      tracks: [
        {
          location: 'remote',
          sessionId: call.session_id,
          trackName: TRACK_MIC,
          endpoint: await endpointFor('down'),
          outputCodec: 'pcm',
          mode: 'stream',
        },
      ],
    });
    const downId = down.body.tracks?.[0]?.adapterId;
    if (validId(downId)) call.adapters = { down: downId };
    if (!down.ok || !validId(downId)) {
      return failMedia(env, call, sfuError('Could not create the outgoing audio adapter', down));
    }
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      return callChanged();
    }

    // Pi modem audio -> SFU, published as a new track in the adapter's own session.
    const up = await sfu(env, 'POST', '/adapters/websocket/new', {
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
    if (validId(upTrack?.adapterId)) call.adapters = { ...call.adapters, up: upTrack.adapterId };
    if (!up.ok || !validId(upTrack?.adapterId) || !validId(upTrack?.sessionId)) {
      return failMedia(env, call, sfuError('Could not create the incoming audio adapter', up));
    }
    call.modem_session_id = upTrack.sessionId;
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      return callChanged();
    }

    const pull = await sfu(env, 'POST', `/sessions/${call.session_id}/tracks/new`, {
      tracks: [{ location: 'remote', sessionId: call.modem_session_id, trackName: TRACK_MODEM }],
    });
    if (
      !pull.ok ||
      (pull.body.requiresImmediateRenegotiation &&
        !validDescription(pull.body.sessionDescription, 'offer'))
    ) {
      return failMedia(env, call, sfuError('Could not subscribe to the call audio', pull));
    }

    const offer = pull.body.requiresImmediateRenegotiation ? pull.body.sessionDescription : null;
    delete call.bridge_started;
    call.state = offer ? 'bridging' : 'active';
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      return callChanged();
    }
    if (!offer) {
      // Audio is up: that is the answer moment for an outbound call. An inbound
      // call already recorded when the operator pressed answer, and COALESCE
      // keeps that earlier, truer timestamp.
      await logCallAnswered(env, call.id, { at: new Date().toISOString() });
    }
    return json({ call, offer });
  });

  // Apply the browser's answer to the pull offer from /connect.
  router.post('/api/calls/renegotiate', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    if (!validDescription(body.answer, 'answer')) return json({ error: 'answer is required' }, 400);

    const call = await readCall(env);
    if (!call || (body.call_id !== undefined && body.call_id !== call.id)) {
      return json({ error: 'No active call' }, 404);
    }
    if (call.state !== 'bridging')
      return json({ error: 'Call is not waiting for renegotiation', call }, 409);

    const result = await sfu(env, 'PUT', `/sessions/${call.session_id}/renegotiate`, {
      sessionDescription: body.answer,
    });
    if (!result.ok)
      return failMedia(env, call, sfuError('Could not renegotiate the session', result));

    call.state = 'active';
    if (!(await writeCall(env, call))) return callChanged();
    await logCallAnswered(env, call.id, { at: new Date().toISOString() });
    return json({ call });
  });

  // Close the adapters for the requested call. Older clients omit the ID.
  router.post('/api/calls/hangup', async (request, env: Env, ctx: ExecutionContext) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;

    const body = request.body === null ? {} : await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const callId = body.call_id;
    if (callId !== undefined && (typeof callId !== 'string' || !callId)) {
      return json({ error: 'Invalid call ID' }, 400);
    }
    const call = await beginEnding(env, (current) => !callId || current.id === callId);
    if (!call) {
      return json({ call: null, already_clear: true });
    }
    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env, call, { reason: 'hangup', endedBy: 'dashboard' });

    call.state = 'ended';
    call.ended_at = new Date().toISOString();
    return json({ call });
  });

  // Daemon-reported incoming call, repeated on every RING to keep it alive.
  router.post('/api/control/calls/incoming', async (request, env: Env, ctx: ExecutionContext) => {
    const authResponse = await handleAuth0(request, env, ctx);
    if (authResponse) return authResponse;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const iccid = typeof body.iccid === 'string' ? body.iccid : '';
    const from = body.from;
    if (!iccid) return json({ error: 'iccid is required' }, 400);

    let existing = await readCall(env);
    const open = existing ? null : await claimRing(env, iccid, from);
    for (;;) {
      if (existing && (existing.state !== 'ringing' || existing.iccid !== iccid)) {
        return json({ ok: false, reason: 'another call is active' }, 409);
      }
      const call: LiveCall = {
        id: existing?.id ?? open?.id ?? crypto.randomUUID(),
        direction: 'inbound',
        state: 'ringing',
        iccid,
        number:
          (typeof from === 'string' ? from : null) ||
          existing?.number ||
          open?.remote_number ||
          null,
        started_at: existing?.started_at ?? open?.started_at ?? new Date().toISOString(),
      };
      if (await writeCall(env, call, RING_TTL_SECONDS, existing)) {
        if (!existing && !open) {
          await logCallStarted(env, call);
        } else if (typeof from === 'string' && from && !(existing?.number ?? open?.remote_number)) {
          await logCallerId(env, call.id, from);
        }
        return json({ ok: true, call });
      }
      existing = await readCall(env);
      // An ended ring should not be revived by a refresh that was already in flight.
      if (!existing) return json({ ok: true, ignored: true });
    }
  });

  // Daemon-reported end: remote hangup, modem failure, or a ring that stopped.
  router.post('/api/control/calls/ended', async (request, env: Env, ctx: ExecutionContext) => {
    const authResponse = await handleAuth0(request, env, ctx);
    if (authResponse) return authResponse;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { call_id: callId, iccid, reason } = body;
    if (!callId && !iccid) return json({ error: 'call_id or iccid is required' }, 400);

    const call = await beginEnding(env, (current) =>
      callId ? current.id === callId : current.iccid === iccid && current.state === 'ringing',
    );
    if (!call) return json({ ok: true, ignored: true });

    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env, call, {
      reason: typeof reason === 'string' && reason ? reason.slice(0, 40) : 'ended',
      endedBy: 'daemon',
    });
    return json({ ok: true, call_id: call.id });
  });
}
