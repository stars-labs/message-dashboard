// Voice calls: browser <-> Cloudflare Realtime SFU <-> voice bridge on the Orange Pi.
//
// Only one call may be active across the whole fleet, so the KV lock below is the
// single source of truth for live call state. D1 holds only the call log, written
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

/** KV key holding the one permitted active call. */
const CALL_KEY = 'voice:active-call';
/** Safety net: a wedged call disappears on its own rather than blocking the fleet. */
const CALL_TTL_SECONDS = 3600;
/**
 * A ringing call lives until the daemon stops refreshing it. The daemon reports
 * every RING (every few seconds), so 20 s would do, but 60 s is the smallest
 * expirationTtl KV accepts. A missed call is also cleared explicitly by
 * /api/control/calls/ended, so the floor only matters if the daemon dies mid-ring.
 */
const RING_TTL_SECONDS = 60;
/** How long a signed adapter endpoint stays valid; matches the call TTL. */
const ENDPOINT_TTL_SECONDS = CALL_TTL_SECONDS;
/** Track names inside the SFU: the browser microphone and the modem audio. */
const TRACK_MIC = 'mic';
const TRACK_MODEM = 'modem';

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1';
const TURN_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Auth0 + RBAC gate. Returns a Response to short-circuit, or null to proceed. */
async function gate(request, env, ctx, permission = 'messages.read') {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission(permission)(request, env, ctx);
  if (permResponse) return permResponse;
  return null;
}

export function missingConfig(env) {
  const needed = [
    'REALTIME_APP_ID',
    'REALTIME_APP_SECRET',
    'TURN_KEY_ID',
    'TURN_API_TOKEN',
    'VOICE_BRIDGE_HOST',
    'API_KEY',
  ];
  return needed.filter((k) => !env[k]);
}

function notConfigured(env) {
  const missing = missingConfig(env);
  if (!missing.length) return null;
  return json({ error: 'Voice calling is not configured', detail: `missing ${missing.join(', ')}` }, 503);
}

async function readCall(env) {
  const raw = await env.SESSIONS.get(CALL_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function writeCall(env, call, ttl = CALL_TTL_SECONDS) {
  await env.SESSIONS.put(CALL_KEY, JSON.stringify(call), { expirationTtl: ttl });
}

async function clearCall(env) {
  await env.SESSIONS.delete(CALL_KEY);
}

/**
 * E.164 only. The SMS sender already refuses anything else for ordinary sends,
 * and a dialer is a place where a loose pattern turns a typo into a wrong number.
 */
export function validNumber(value) {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
}

function validIccid(value) {
  return typeof value === 'string' && /^\d{18,22}$/.test(value);
}

function validDescription(value, type) {
  return Boolean(value && value.type === type && typeof value.sdp === 'string' && value.sdp);
}

function toHex(buffer) {
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
export async function adapterEndpoint(env, { callId, leg, action, iccid, number, exp }) {
  const numberSegment = action === 'answer' ? '-' : number;
  const message = [callId, leg, action, iccid, numberSegment, String(exp)].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.API_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  const segments = [callId, leg, action, iccid, numberSegment, String(exp), sig].map(encodeURIComponent);
  return `wss://${env.VOICE_BRIDGE_HOST}/voice/${segments.join('/')}`;
}

/** SFU REST call. `body === undefined` sends no body at all, which sessions/new requires. */
async function sfu(env, method, path, body) {
  const init = {
    method,
    headers: { Authorization: `Bearer ${env.REALTIME_APP_SECRET}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${SFU_BASE}/apps/${env.REALTIME_APP_ID}${path}`, init);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  // The SFU reports per-track failures inside a 200 as well as at the top level.
  const trackError = (parsed.tracks || []).find((t) => t.errorCode);
  const ok = response.ok && !parsed.errorCode && !trackError;
  return { ok, status: response.status, body: parsed };
}

function sfuError(message, result) {
  return json({ error: message, detail: result.body }, 502);
}

/** Creates the browser session and publishes its mic. Returns { sessionId, answer } or { error }. */
async function publishMic(env, offer, mid) {
  const session = await sfu(env, 'POST', '/sessions/new');
  if (!session.ok) return { error: sfuError('Could not create an SFU session', session) };
  const sessionId = session.body.sessionId;

  const tracks = await sfu(env, 'POST', `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: offer,
    tracks: [{ location: 'local', mid, trackName: TRACK_MIC }],
  });
  if (!tracks.ok) return { error: sfuError('Could not publish the microphone', tracks) };
  return { sessionId, answer: tracks.body.sessionDescription };
}

async function closeAdapters(env, call) {
  const ids = [call?.adapters?.up, call?.adapters?.down].filter(Boolean);
  if (!ids.length) return;
  try {
    await sfu(env, 'POST', '/adapters/websocket/close', { tracks: ids.map((adapterId) => ({ adapterId })) });
  } catch {
    // Best effort: the daemon also hangs up when its WebSocket drops or the call TTL ends.
  }
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
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
/** How far back a repeat RING may find the row it belongs to. */
const RING_REJOIN_MS = 2 * 60 * 1000;

/** D1 rejects a statement with more bound parameters than this. */
const D1_MAX_BOUND_PARAMETERS = 100;

const HISTORY_COLUMNS = `id, direction, iccid, remote_number, outcome, end_reason,
         started_at, answered_at, ended_at, duration_seconds, requested_by, answered_by`;

async function history(env, write) {
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
function sweepStaleCalls(db, now) {
  return db.prepare(
    `UPDATE calls
        SET outcome = CASE WHEN answered_at IS NULL THEN 'missed' ELSE 'failed' END,
            end_reason = 'stale',
            ended_at = COALESCE(ended_at, ?)
      WHERE outcome = 'in_progress'
        AND (started_at < ? OR (answered_at IS NULL AND started_at < ?))`,
  ).bind(
    now,
    new Date(Date.now() - STALE_CALL_MS).toISOString(),
    new Date(Date.now() - STALE_RING_MS).toISOString(),
  ).run();
}

/**
 * Claim the log row for a ring and return whichever row is authoritative.
 *
 * The daemon reports `RING` and the caller id a few hundred milliseconds apart.
 * Neither the KV lock (eventually consistent) nor a plain D1 read (the other
 * request may not have committed yet) can tell those two reports apart, so the
 * database decides: a partial unique index allows one open inbound row per SIM
 * (migration 078), the losing INSERT is ignored, and the loser reads back the
 * winner. Returns null when D1 is unavailable; the caller then falls back to KV.
 */
async function claimRing(env, iccid, from) {
  if (!env.DB) return null;
  try {
    const now = new Date().toISOString();
    await sweepStaleCalls(env.DB, now);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO calls (id, direction, iccid, remote_number, outcome, started_at)
       VALUES (?, 'inbound', ?, ?, 'in_progress', ?)`,
    ).bind(crypto.randomUUID(), iccid, from ?? null, now).run();

    const row = await env.DB.prepare(
      `SELECT id, started_at, remote_number
         FROM calls
        WHERE iccid = ? AND direction = 'inbound' AND outcome = 'in_progress'
          AND answered_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
    ).bind(iccid).first();
    return row ?? null;
  } catch (error) {
    console.error('call history ring claim failed', error);
    return null;
  }
}

/** Open the row for a call that just started. Repeat reports must not duplicate it. */
function logCallStarted(env, call) {
  return history(env, async (db) => {
    // Sweep first: a ring whose TTL expired with no end report would otherwise
    // sit in progress forever and read as a call that never finished.
    await sweepStaleCalls(db, new Date().toISOString());

    await db.prepare(
      `INSERT INTO calls (id, direction, iccid, remote_number, outcome, started_at, requested_by)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      call.id,
      call.direction,
      call.iccid,
      call.number ?? null,
      call.started_at,
      call.requested_by ?? null,
    ).run();
  });
}

/** A caller id that only arrived with a later RING. */
function logCallerId(env, callId, number) {
  return history(env, (db) => db.prepare(
    `UPDATE calls SET remote_number = ? WHERE id = ? AND remote_number IS NULL`,
  ).bind(number, callId).run());
}

/** Answer time, and for an inbound call whoever pressed answer. */
function logCallAnswered(env, callId, { at, by = null }) {
  return history(env, (db) => db.prepare(
    `UPDATE calls
        SET answered_at = COALESCE(answered_at, ?), answered_by = COALESCE(answered_by, ?)
      WHERE id = ? AND outcome = 'in_progress'`,
  ).bind(at, by, callId).run());
}

/**
 * What to call a call that never carried audio, once it is known who ended it.
 * `dashboard` is the operator, `daemon` the Pi, `worker` a setup failure here.
 */
export function unansweredOutcome(direction, endedBy, reason) {
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
 * right even if the KV copy of the call was already gone.
 */
function logCallEnded(env, call, { reason, endedBy }) {
  return history(env, (db) => {
    const endedAt = new Date().toISOString();
    return db.prepare(
      `UPDATE calls
          SET ended_at = ?,
              end_reason = ?,
              duration_seconds = CASE
                WHEN answered_at IS NULL THEN 0
                ELSE MAX(0, CAST((julianday(?) - julianday(answered_at)) * 86400 AS INTEGER))
              END,
              outcome = CASE WHEN answered_at IS NULL THEN ? ELSE 'answered' END
        WHERE id = ? AND outcome = 'in_progress'`,
    ).bind(
      endedAt,
      reason,
      endedAt,
      unansweredOutcome(call.direction, endedBy, reason),
      call.id,
    ).run();
  });
}

/** Attach each call's SIM identity, when that SIM is still in inventory. */
async function enrichCallPage(db, calls) {
  const iccids = [...new Set(calls.map((call) => call.iccid).filter(Boolean))];
  const sims = new Map();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db.prepare(
      `SELECT iccid, number, carrier, sim_index FROM device_view WHERE iccid IN (${placeholders})`,
    ).bind(...chunk).all();
    for (const sim of result.results || result) sims.set(sim.iccid, sim);
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

function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function setupCallRoutes(router) {
  // Current call state, for the dashboard to poll.
  router.get('/api/calls/state', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    return json({ call: await readCall(env) });
  });

  // The call log. Read only when someone opens the history — never on the
  // polling path — so it cannot eat the D1 row-read quota.
  router.get('/api/calls/history', async (request, env, ctx) => {
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
    ).bind(...binds).all();

    const rows = results || [];
    const page = rows.slice(0, limit);
    return json({ calls: await enrichCallPage(env.DB, page), has_more: rows.length > limit });
  });

  // Short-lived ICE servers for the browser's PeerConnection. The TURN token
  // itself stays in the Worker; the browser only ever sees a 10-minute credential.
  router.get('/api/calls/ice', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const response = await fetch(`${TURN_BASE}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 600 }),
    });
    if (!response.ok) return json({ error: 'Could not issue ICE servers', detail: await response.text() }, 502);
    return json(await response.json());
  });

  // Place an outbound call: take the lock, then publish the browser mic.
  router.post('/api/calls/dial', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { iccid, number, offer, mid } = body;
    if (!validIccid(iccid)) return json({ error: 'iccid is required' }, 400);
    if (!validNumber(number)) return json({ error: 'number must be E.164, for example +6591234567' }, 400);
    if (!validDescription(offer, 'offer') || !mid) return json({ error: 'offer and mid are required' }, 400);

    const existing = await readCall(env);
    if (existing) return json({ error: 'Another call is already active', call: existing }, 409);

    const call = {
      id: crypto.randomUUID(),
      direction: 'outbound',
      state: 'connecting',
      iccid,
      number,
      started_at: new Date().toISOString(),
      requested_by: request.user?.sub ?? request.user?.id ?? null,
    };
    await writeCall(env, call);
    await logCallStarted(env, call);

    const media = await publishMic(env, offer, mid);
    if (media.error) {
      await clearCall(env);
      await logCallEnded(env, call, { reason: 'sfu_error', endedBy: 'worker' });
      return media.error;
    }
    call.session_id = media.sessionId;
    await writeCall(env, call);
    return json({ call, answer: media.answer });
  });

  // Answer the call the daemon reported as ringing.
  router.post('/api/calls/answer', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { offer, mid } = body;
    if (!validDescription(offer, 'offer') || !mid) return json({ error: 'offer and mid are required' }, 400);

    const call = await readCall(env);
    if (!call) return json({ error: 'No call to answer' }, 404);
    if (call.direction !== 'inbound' || call.state !== 'ringing') {
      return json({ error: 'Only a ringing inbound call can be answered', call }, 409);
    }

    // Take the call out of `ringing` first so a RING report cannot shorten its TTL.
    call.state = 'connecting';
    call.answered_at = new Date().toISOString();
    call.answered_by = request.user?.sub ?? request.user?.id ?? null;
    await writeCall(env, call);
    await logCallAnswered(env, call.id, { at: call.answered_at, by: call.answered_by });

    const media = await publishMic(env, offer, mid);
    if (media.error) {
      await clearCall(env);
      await logCallEnded(env, call, { reason: 'sfu_error', endedBy: 'worker' });
      return media.error;
    }
    call.session_id = media.sessionId;
    await writeCall(env, call);
    return json({ call, answer: media.answer });
  });

  // Bridge the browser session to the Pi. Called once the PeerConnection is up.
  router.post('/api/calls/connect', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const call = await readCall(env);
    if (!call) return json({ error: 'No active call' }, 404);
    if (call.state !== 'connecting' || !call.session_id) {
      return json({ error: 'Call is not ready to connect', call }, 409);
    }

    const action = call.direction === 'outbound' ? 'dial' : 'answer';
    const exp = Math.floor(Date.now() / 1000) + ENDPOINT_TTL_SECONDS;
    const endpointFor = (leg) =>
      adapterEndpoint(env, { callId: call.id, leg, action, iccid: call.iccid, number: call.number, exp });

    // Browser mic -> Pi. Its response carries no sessionId: it reads an existing track.
    const down = await sfu(env, 'POST', '/adapters/websocket/new', {
      tracks: [{
        location: 'remote',
        sessionId: call.session_id,
        trackName: TRACK_MIC,
        endpoint: await endpointFor('down'),
        outputCodec: 'pcm',
        mode: 'stream',
      }],
    });
    if (!down.ok) {
      await clearCall(env);
      await logCallEnded(env, call, { reason: 'sfu_error', endedBy: 'worker' });
      return sfuError('Could not create the outgoing audio adapter', down);
    }
    call.adapters = { down: down.body.tracks[0].adapterId };

    // Pi modem audio -> SFU, published as a new track in the adapter's own session.
    const up = await sfu(env, 'POST', '/adapters/websocket/new', {
      tracks: [{
        location: 'local',
        trackName: TRACK_MODEM,
        endpoint: await endpointFor('up'),
        inputCodec: 'pcm',
        mode: 'buffer',
      }],
    });
    if (!up.ok) {
      await closeAdapters(env, call);
      await clearCall(env);
      await logCallEnded(env, call, { reason: 'sfu_error', endedBy: 'worker' });
      return sfuError('Could not create the incoming audio adapter', up);
    }
    call.adapters.up = up.body.tracks[0].adapterId;
    call.modem_session_id = up.body.tracks[0].sessionId;
    call.state = 'bridging';
    await writeCall(env, call);

    const pull = await sfu(env, 'POST', `/sessions/${call.session_id}/tracks/new`, {
      tracks: [{ location: 'remote', sessionId: call.modem_session_id, trackName: TRACK_MODEM }],
    });
    if (!pull.ok) {
      await closeAdapters(env, call);
      await clearCall(env);
      await logCallEnded(env, call, { reason: 'sfu_error', endedBy: 'worker' });
      return sfuError('Could not subscribe to the call audio', pull);
    }

    const offer = pull.body.requiresImmediateRenegotiation ? pull.body.sessionDescription : null;
    if (!offer) {
      call.state = 'active';
      await writeCall(env, call);
      // Audio is up: that is the answer moment for an outbound call. An inbound
      // call already recorded when the operator pressed answer, and COALESCE
      // keeps that earlier, truer timestamp.
      await logCallAnswered(env, call.id, { at: new Date().toISOString() });
    }
    return json({ call, offer });
  });

  // Apply the browser's answer to the pull offer from /connect.
  router.post('/api/calls/renegotiate', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;
    const unconfigured = notConfigured(env);
    if (unconfigured) return unconfigured;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    if (!validDescription(body.answer, 'answer')) return json({ error: 'answer is required' }, 400);

    const call = await readCall(env);
    if (!call) return json({ error: 'No active call' }, 404);
    if (call.state !== 'bridging') return json({ error: 'Call is not waiting for renegotiation', call }, 409);

    const result = await sfu(env, 'PUT', `/sessions/${call.session_id}/renegotiate`, {
      sessionDescription: body.answer,
    });
    if (!result.ok) return sfuError('Could not renegotiate the session', result);

    call.state = 'active';
    await writeCall(env, call);
    await logCallAnswered(env, call.id, { at: new Date().toISOString() });
    return json({ call });
  });

  // End whatever is active. Safe to call twice: a missing call is not an error,
  // because the hangup button must always leave the fleet unlocked. Closing the
  // adapters drops the daemon's WebSockets, which is what makes it hang up.
  router.post('/api/calls/hangup', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;

    const call = await readCall(env);
    if (!call) return json({ call: null, already_clear: true });
    await closeAdapters(env, call);
    await clearCall(env);
    await logCallEnded(env, call, { reason: 'hangup', endedBy: 'dashboard' });

    call.state = 'ended';
    call.ended_at = new Date().toISOString();
    return json({ call });
  });

  // Daemon-reported incoming call, repeated on every RING to keep it alive.
  router.post('/api/control/calls/incoming', async (request, env, ctx) => {
    const authResponse = await handleAuth0(request, env, ctx);
    if (authResponse) return authResponse;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { iccid, from } = body;
    if (!iccid) return json({ error: 'iccid is required' }, 400);

    const existing = await readCall(env);
    if (existing && (existing.state !== 'ringing' || existing.iccid !== iccid)) {
      // A second modem ringing during an active call is expected with 90+ SIMs.
      return json({ ok: false, reason: 'another call is active' }, 409);
    }

    // The log row is a ring's identity: the KV lock may not have caught up, but
    // the database arbitrates between the RING and the caller-id report.
    const open = existing ? null : await claimRing(env, iccid, from);
    const call = {
      id: existing?.id ?? open?.id ?? crypto.randomUUID(),
      direction: 'inbound',
      state: 'ringing',
      iccid,
      number: from || existing?.number || open?.remote_number || null,
      started_at: existing?.started_at ?? open?.started_at ?? new Date().toISOString(),
    };
    await writeCall(env, call, RING_TTL_SECONDS);

    // A caller id that arrived with a later RING fills the blank the first report
    // left. Without D1 there is no row to claim, so the KV lock stands alone.
    if (!existing && !open) {
      await logCallStarted(env, call);
    } else if (from && !(existing?.number ?? open?.remote_number)) {
      await logCallerId(env, call.id, from);
    }
    return json({ ok: true, call });
  });

  // Daemon-reported end: remote hangup, modem failure, or a ring that stopped.
  router.post('/api/control/calls/ended', async (request, env, ctx) => {
    const authResponse = await handleAuth0(request, env, ctx);
    if (authResponse) return authResponse;

    const body = await readJson(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const { call_id: callId, iccid, reason } = body;
    if (!callId && !iccid) return json({ error: 'call_id or iccid is required' }, 400);

    const call = await readCall(env);
    const matches = call && (callId
      ? call.id === callId
      : call.iccid === iccid && call.state === 'ringing');
    if (!matches) return json({ ok: true, ignored: true });

    await closeAdapters(env, call);
    await clearCall(env);
    await logCallEnded(env, call, {
      reason: typeof reason === 'string' && reason ? reason.slice(0, 40) : 'ended',
      endedBy: 'daemon',
    });
    return json({ ok: true, call_id: call.id });
  });
}
