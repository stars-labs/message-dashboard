import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { adapterEndpoint, missingConfig, setupCallRoutes, unansweredOutcome, validNumber } from './calls.js';

const CALL_KEY = 'voice:active-call';
const SESSION_TOKEN = 'session-token';
const ICCID = '8965012306052373985';
const OFFER = { type: 'offer', sdp: 'v=0 offer' };

/** Collects the handlers so they can be invoked directly. */
function routerStub() {
  const routes = {};
  const record = (method) => (path, handler) => {
    routes[`${method} ${path}`] = handler;
  };
  return { routes, get: record('GET'), post: record('POST'), put: record('PUT') };
}

/** Keyed in-memory SESSIONS namespace: holds both the login session and the call lock. */
function kvStub(call = null) {
  const store = new Map();
  store.set(SESSION_TOKEN, {
    value: JSON.stringify({ expires_at: Date.now() + 60_000, user: { sub: 'auth0|op', roles: ['admin'] } }),
  });
  if (call) store.set(CALL_KEY, { value: JSON.stringify(call) });
  return {
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async put(key, value, options) {
      store.set(key, { value, ttl: options?.expirationTtl });
    },
    async delete(key) {
      store.delete(key);
    },
    call: () => (store.has(CALL_KEY) ? JSON.parse(store.get(CALL_KEY).value) : null),
    ttl: () => store.get(CALL_KEY)?.ttl,
  };
}

/**
 * A SESSIONS namespace whose call-lock reads always miss, the way an eventually
 * consistent KV read can right after a write. Login sessions still resolve.
 */
function staleKvStub() {
  const kv = kvStub();
  return { ...kv, get: async (key) => (key === CALL_KEY ? null : kv.get(key)) };
}

function envStub(overrides = {}) {
  return {
    SESSIONS: kvStub(),
    REALTIME_APP_ID: 'app',
    REALTIME_APP_SECRET: 'secret',
    TURN_KEY_ID: 'turn',
    TURN_API_TOKEN: 'token',
    VOICE_BRIDGE_HOST: 'voice-bridge.example.test',
    API_KEY: 'daemon-key',
    ...overrides,
  };
}

/**
 * A D1 stub backed by real SQLite running the real migration, so the call log's
 * SQL — ON CONFLICT, the COALESCE guards, and the julianday duration — is under
 * test rather than re-implemented in a fake.
 */
function d1Stub() {
  const db = new Database(':memory:');
  db.run(readFileSync(`${import.meta.dir}/../../migrations/077_add_call_log.sql`, 'utf8'));
  // 078 adds the partial unique index that arbitrates between the two reports
  // of one ring, so the race below is enforced by SQLite, not by a fake.
  db.run(readFileSync(`${import.meta.dir}/../../migrations/078_one_open_ring_per_sim.sql`, 'utf8'));
  // Only the columns /api/calls/history reads; the real view is built from sims + modems.
  db.run('CREATE TABLE device_view (iccid TEXT, number TEXT, carrier TEXT, sim_index INTEGER)');

  return {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...args) {
          params = args;
          return statement;
        },
        async run() {
          db.query(sql).run(...params);
          return { success: true };
        },
        async all() {
          return { results: db.query(sql).all(...params) };
        },
        async first() {
          return db.query(sql).get(...params) ?? null;
        },
      };
      return statement;
    },
    rows: () => db.query('SELECT * FROM calls ORDER BY started_at, id').all(),
    row: (id) => db.query('SELECT * FROM calls WHERE id = ?').get(id),
    seedCall: (call) => db.query(
      `INSERT INTO calls (id, direction, iccid, remote_number, outcome, started_at, answered_at, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.id,
      call.direction ?? 'inbound',
      call.iccid ?? ICCID,
      call.remote_number ?? null,
      call.outcome ?? 'in_progress',
      call.started_at ?? '2026-09-17T10:00:00.000Z',
      call.answered_at ?? null,
      call.requested_by ?? null,
    ),
    seedSim: (sim) => db.query('INSERT INTO device_view (iccid, number, carrier, sim_index) VALUES (?, ?, ?, ?)')
      .run(sim.iccid, sim.number, sim.carrier, sim.sim_index),
  };
}

/** A router plus an env whose SESSIONS holds `call` and whose DB logs history. */
function setupWithHistory(call = null) {
  const router = routerStub();
  setupCallRoutes(router);
  const DB = d1Stub();
  return { router, env: envStub({ SESSIONS: kvStub(call), DB }), DB };
}

async function invokeGet(router, path, query, env) {
  const handler = router.routes[`GET ${path}`];
  const suffix = query ? `?${new URLSearchParams(query)}` : '';
  const req = request(path, null, env);
  return handler({ ...req, method: 'GET', url: `${req.url}${suffix}` }, env, {});
}

/**
 * Build a request the way the router delivers it: the router assigns
 * `request.env` before dispatch (server/index.js). Browser routes authenticate
 * with the auth_token cookie; /api/control/ routes with X-API-Key.
 *
 * A plain object rather than `new Request`: the test preload installs a DOM
 * Request that drops the forbidden Cookie header, as a browser would.
 */
function request(path, body, env, headers = {}) {
  const daemon = path.startsWith('/api/control/');
  const all = {
    'content-type': 'application/json',
    ...(daemon ? { 'x-api-key': env.API_KEY } : { cookie: `auth_token=${SESSION_TOKEN}` }),
  };
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = value;
  return {
    url: `https://example.test${path}`,
    method: 'POST',
    env,
    ctx: {},
    headers: { get: (name) => all[name.toLowerCase()] ?? null },
    async json() {
      return body ?? {};
    },
  };
}

/** Records SFU calls and answers them from a path -> response table. */
const realFetch = globalThis.fetch;
function stubSfu(responses) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/v1/apps/app', '');
    calls.push({ path, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const entry = typeof responses === 'function' ? responses(path, calls.length) : responses[path];
    const [status, body] = entry ?? [404, { errorCode: 'not_found' }];
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function invoke(router, method, path, body, env, headers) {
  const handler = router.routes[`${method} ${path}`];
  return handler(request(path, body, env, headers), env, {});
}

function setup(call = null) {
  const router = routerStub();
  setupCallRoutes(router);
  const env = envStub({ SESSIONS: kvStub(call) });
  return { router, env };
}

describe('number validation', () => {
  test('accepts E.164 and rejects everything else', () => {
    expect(validNumber('+6597817169')).toBe(true);
    expect(validNumber('+8613520607015')).toBe(true);
    expect(validNumber('6597817169')).toBe(false);
    expect(validNumber('+0597817169')).toBe(false);
    expect(validNumber('+65 9781 7169')).toBe(false);
    expect(validNumber('10086')).toBe(false);
    expect(validNumber('')).toBe(false);
    expect(validNumber(null)).toBe(false);
  });
});

describe('configuration guard', () => {
  test('names every setting that is missing', () => {
    expect(missingConfig(envStub())).toEqual([]);
    expect(missingConfig({ REALTIME_APP_ID: 'a' })).toEqual([
      'REALTIME_APP_SECRET',
      'TURN_KEY_ID',
      'TURN_API_TOKEN',
      'VOICE_BRIDGE_HOST',
      'API_KEY',
    ]);
  });
});

describe('signed adapter endpoint', () => {
  // The daemon verifies the same vector; change both sides together.
  test('matches the shared HMAC test vector', async () => {
    const url = await adapterEndpoint(
      { API_KEY: 'test-key', VOICE_BRIDGE_HOST: 'voice-bridge.itoken.world' },
      {
        callId: '11111111-1111-4111-8111-111111111111',
        leg: 'up',
        action: 'dial',
        iccid: ICCID,
        number: '+6592953543',
        exp: 1800000000,
      },
    );
    expect(url).toBe(
      'wss://voice-bridge.itoken.world/voice/11111111-1111-4111-8111-111111111111/up/dial/'
        + '8965012306052373985/%2B6592953543/1800000000/'
        + '2228b401ad42d60138d9f2131e8b4056a77fe21d77ab41810698a0bae6f1e325',
    );
  });

  test('an answer endpoint carries no number, whatever the caller id was', async () => {
    const env = { API_KEY: 'test-key', VOICE_BRIDGE_HOST: 'h' };
    const base = { callId: 'c', leg: 'down', action: 'answer', iccid: ICCID, exp: 1 };
    const a = await adapterEndpoint(env, { ...base, number: '92953543' });
    const b = await adapterEndpoint(env, { ...base, number: null });
    expect(a).toBe(b);
    expect(a.split('/')[8]).toBe('-');
  });
});

describe('outbound media setup', () => {
  test('dial takes the lock, creates a bodiless session and publishes the mic', async () => {
    const { router, env } = setup();
    const sfu = stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [200, { sessionDescription: { type: 'answer', sdp: 'v=0 answer' }, tracks: [{ trackName: 'mic', mid: '0' }] }],
    });

    const response = await invoke(router, 'POST', '/api/calls/dial', { iccid: ICCID, number: '+6592953543', offer: OFFER, mid: '0' }, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.answer).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(sfu[0]).toEqual({ path: '/sessions/new', method: 'POST', body: undefined });
    expect(sfu[1].body).toEqual({ sessionDescription: OFFER, tracks: [{ location: 'local', mid: '0', trackName: 'mic' }] });
    expect(env.SESSIONS.call()).toMatchObject({ direction: 'outbound', state: 'connecting', session_id: 'browser' });
  });

  test('an SFU failure releases the lock', async () => {
    const { router, env } = setup();
    stubSfu({ '/sessions/new': [500, { errorCode: 'boom' }] });

    const response = await invoke(router, 'POST', '/api/calls/dial', { iccid: ICCID, number: '+6592953543', offer: OFFER, mid: '0' }, env);

    expect(response.status).toBe(502);
    expect(env.SESSIONS.call()).toBeNull();
  });

  test('a second dial is refused while any call exists', async () => {
    const { router, env } = setup({ id: 'x', direction: 'inbound', state: 'ringing', iccid: 'other' });
    const sfu = stubSfu({});

    const response = await invoke(router, 'POST', '/api/calls/dial', { iccid: ICCID, number: '+6592953543', offer: OFFER, mid: '0' }, env);

    expect(response.status).toBe(409);
    expect(sfu).toHaveLength(0);
  });
});

describe('bridging to the Pi', () => {
  const connecting = { id: 'call-1', direction: 'outbound', state: 'connecting', iccid: ICCID, number: '+6592953543', session_id: 'browser' };

  test('creates both adapters with signed endpoints and pulls the modem track', async () => {
    const { router, env } = setup(connecting);
    const sfu = stubSfu((path, n) => {
      if (path === '/adapters/websocket/new' && n === 1) return [200, { tracks: [{ trackName: 'mic', adapterId: 'down-id' }] }];
      if (path === '/adapters/websocket/new') return [200, { tracks: [{ trackName: 'modem', adapterId: 'up-id', sessionId: 'modem-session' }] }];
      if (path === '/sessions/browser/tracks/new') {
        return [200, { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'v=0 pull' }, tracks: [{ trackName: 'modem', mid: '1' }] }];
      }
      return undefined;
    });

    const response = await invoke(router, 'POST', '/api/calls/connect', {}, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.offer).toEqual({ type: 'offer', sdp: 'v=0 pull' });

    const [down] = sfu[0].body.tracks;
    expect(down).toMatchObject({ location: 'remote', sessionId: 'browser', trackName: 'mic', outputCodec: 'pcm', mode: 'stream' });
    expect(down.endpoint).toMatch(/^wss:\/\/voice-bridge\.example\.test\/voice\/call-1\/down\/dial\/8965012306052373985\/%2B6592953543\/\d+\/[0-9a-f]{64}$/);

    const [up] = sfu[1].body.tracks;
    expect(up).toMatchObject({ location: 'local', trackName: 'modem', inputCodec: 'pcm', mode: 'buffer' });
    expect(up.endpoint).toContain('/voice/call-1/up/dial/');

    expect(sfu[2].body).toEqual({ tracks: [{ location: 'remote', sessionId: 'modem-session', trackName: 'modem' }] });
    expect(env.SESSIONS.call()).toMatchObject({ state: 'bridging', adapters: { down: 'down-id', up: 'up-id' }, modem_session_id: 'modem-session' });
  });

  test('a per-track adapter error inside a 200 is a failure and closes what was created', async () => {
    const { router, env } = setup(connecting);
    const sfu = stubSfu((path, n) => {
      if (path === '/adapters/websocket/new' && n === 1) return [200, { tracks: [{ adapterId: 'down-id' }] }];
      if (path === '/adapters/websocket/new') return [200, { tracks: [{ trackName: 'modem', errorCode: 'adapter_unavailable' }] }];
      if (path === '/adapters/websocket/close') return [200, { tracks: [] }];
      return undefined;
    });

    const response = await invoke(router, 'POST', '/api/calls/connect', {}, env);

    expect(response.status).toBe(502);
    expect(sfu.at(-1)).toMatchObject({ path: '/adapters/websocket/close', body: { tracks: [{ adapterId: 'down-id' }] } });
    expect(env.SESSIONS.call()).toBeNull();
  });

  test('an inbound call signs an answer endpoint', async () => {
    const { router, env } = setup({ ...connecting, direction: 'inbound', number: '92953543' });
    const sfu = stubSfu((path, n) => {
      if (path === '/adapters/websocket/new') return [200, { tracks: [{ adapterId: `a${n}`, sessionId: 'modem-session' }] }];
      return [200, { requiresImmediateRenegotiation: false, tracks: [] }];
    });

    const response = await invoke(router, 'POST', '/api/calls/connect', {}, env);

    expect(response.status).toBe(200);
    expect((await response.json()).offer).toBeNull();
    expect(sfu[0].body.tracks[0].endpoint).toContain('/down/answer/8965012306052373985/-/');
    expect(env.SESSIONS.call().state).toBe('active');
  });

  test('renegotiate applies the browser answer with PUT and marks the call active', async () => {
    const { router, env } = setup({ ...connecting, state: 'bridging' });
    const sfu = stubSfu({ '/sessions/browser/renegotiate': [200, {}] });
    const answer = { type: 'answer', sdp: 'v=0 answer' };

    const response = await invoke(router, 'POST', '/api/calls/renegotiate', { answer }, env);

    expect(response.status).toBe(200);
    expect(sfu[0]).toEqual({ path: '/sessions/browser/renegotiate', method: 'PUT', body: { sessionDescription: answer } });
    expect(env.SESSIONS.call().state).toBe('active');
  });
});

describe('answering and hanging up', () => {
  test('only a ringing inbound call can be answered', async () => {
    const { router, env } = setup({ id: 'x', direction: 'outbound', state: 'active', iccid: ICCID });
    stubSfu({});

    const response = await invoke(router, 'POST', '/api/calls/answer', { offer: OFFER, mid: '0' }, env);

    expect(response.status).toBe(409);
  });

  test('answering moves the call out of ringing and onto the long TTL', async () => {
    const { router, env } = setup({ id: 'x', direction: 'inbound', state: 'ringing', iccid: ICCID, number: '92953543' });
    stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [200, { sessionDescription: { type: 'answer', sdp: 'a' } }],
    });

    const response = await invoke(router, 'POST', '/api/calls/answer', { offer: OFFER, mid: '0' }, env);

    expect(response.status).toBe(200);
    expect(env.SESSIONS.call()).toMatchObject({ state: 'connecting', session_id: 'browser' });
    expect(env.SESSIONS.ttl()).toBe(3600);
  });

  test('hangup closes the adapters and clears the lock, and is idempotent', async () => {
    const { router, env } = setup({ id: 'x', state: 'active', adapters: { up: 'u', down: 'd' } });
    const sfu = stubSfu({ '/adapters/websocket/close': [200, { tracks: [] }] });

    const first = await invoke(router, 'POST', '/api/calls/hangup', {}, env);
    const second = await invoke(router, 'POST', '/api/calls/hangup', {}, env);

    expect(first.status).toBe(200);
    expect(sfu[0].body).toEqual({ tracks: [{ adapterId: 'u' }, { adapterId: 'd' }] });
    expect(env.SESSIONS.call()).toBeNull();
    expect((await second.json()).already_clear).toBe(true);
  });
});

describe('incoming call reporting from the daemon', () => {
  test('records a ringing call with its caller id on the ring TTL', async () => {
    const { router, env } = setup();

    const response = await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID, from: '92953543' }, env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.call).toMatchObject({ direction: 'inbound', state: 'ringing', number: '92953543' });
    expect(env.SESSIONS.call().iccid).toBe(ICCID);
    expect(env.SESSIONS.ttl()).toBe(60);
  });

  test('a repeated RING keeps the same call id', async () => {
    const { router, env } = setup({ id: 'ring-1', direction: 'inbound', state: 'ringing', iccid: ICCID, started_at: 't' });

    const response = await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID, from: '92953543' }, env);

    expect((await response.json()).call.id).toBe('ring-1');
  });

  test('refuses a second ringing modem while a call is active', async () => {
    const { router, env } = setup({ id: 'x', direction: 'outbound', state: 'active', iccid: 'other' });

    const response = await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: '8965012211290057038', from: '90421798' }, env);

    expect(response.status).toBe(409);
    expect(env.SESSIONS.call().iccid).toBe('other');
  });

  test('rejects a report without an iccid', async () => {
    const { router, env } = setup();

    const response = await invoke(router, 'POST', '/api/control/calls/incoming', { from: '90421798' }, env);

    expect(response.status).toBe(400);
  });
});

describe('end reporting from the daemon', () => {
  test('a matching call id closes the adapters and clears the lock', async () => {
    const { router, env } = setup({ id: 'call-1', state: 'active', iccid: ICCID, adapters: { up: 'u' } });
    const sfu = stubSfu({ '/adapters/websocket/close': [200, { tracks: [] }] });

    const response = await invoke(router, 'POST', '/api/control/calls/ended', { call_id: 'call-1', iccid: ICCID }, env);

    expect(response.status).toBe(200);
    expect(sfu).toHaveLength(1);
    expect(env.SESSIONS.call()).toBeNull();
  });

  test('a ring that stops without a call id clears only a ringing call on that SIM', async () => {
    const { router, env } = setup({ id: 'r', state: 'ringing', iccid: ICCID });

    const response = await invoke(router, 'POST', '/api/control/calls/ended', { iccid: ICCID }, env);

    expect(response.status).toBe(200);
    expect(env.SESSIONS.call()).toBeNull();
  });

  test('a stale report for another call is ignored', async () => {
    const { router, env } = setup({ id: 'current', state: 'active', iccid: ICCID });

    const byId = await invoke(router, 'POST', '/api/control/calls/ended', { call_id: 'old', iccid: ICCID }, env);
    const byIccid = await invoke(router, 'POST', '/api/control/calls/ended', { iccid: ICCID }, env);

    expect((await byId.json()).ignored).toBe(true);
    expect((await byIccid.json()).ignored).toBe(true);
    expect(env.SESSIONS.call().id).toBe('current');
  });
});

describe('call history logging', () => {
  test('the first RING opens a row, repeats do not, and a late caller id fills the blank', async () => {
    const { router, env, DB } = setupWithHistory();

    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env);
    const id = env.SESSIONS.call().id;
    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env);
    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID, from: '92953543' }, env);

    expect(DB.rows()).toHaveLength(1);
    expect(DB.row(id)).toMatchObject({
      direction: 'inbound',
      iccid: ICCID,
      remote_number: '92953543',
      outcome: 'in_progress',
      duration_seconds: 0,
    });
  });

  test('a ring the daemon reports as over is a missed call', async () => {
    const { router, env, DB } = setupWithHistory({
      id: 'ring-1', direction: 'inbound', state: 'ringing', iccid: ICCID, started_at: '2026-09-17T10:00:00.000Z',
    });
    DB.seedCall({ id: 'ring-1', remote_number: '92953543' });
    stubSfu({});

    await invoke(router, 'POST', '/api/control/calls/ended', { call_id: 'ring-1', iccid: ICCID, reason: 'missed' }, env);

    expect(DB.row('ring-1')).toMatchObject({ outcome: 'missed', end_reason: 'missed', duration_seconds: 0 });
    expect(DB.row('ring-1').ended_at).toBeTruthy();
  });

  test('hanging up on a ringing call is a rejection, not a missed call', async () => {
    const { router, env, DB } = setupWithHistory({ id: 'ring-2', direction: 'inbound', state: 'ringing', iccid: ICCID });
    DB.seedCall({ id: 'ring-2' });
    stubSfu({});

    await invoke(router, 'POST', '/api/calls/hangup', {}, env);

    expect(DB.row('ring-2')).toMatchObject({ outcome: 'rejected', end_reason: 'hangup' });
  });

  test('an answered call records talk time from the answer, not from the first ring', async () => {
    const { router, env, DB } = setupWithHistory({ id: 'call-9', direction: 'inbound', state: 'active', iccid: ICCID });
    DB.seedCall({
      id: 'call-9',
      started_at: '2026-09-17T10:00:00.000Z',
      answered_at: new Date(Date.now() - 53_000).toISOString(),
    });
    stubSfu({});

    await invoke(router, 'POST', '/api/control/calls/ended', { call_id: 'call-9', iccid: ICCID, reason: 'remote_hangup' }, env);

    const row = DB.row('call-9');
    expect(row.outcome).toBe('answered');
    expect(row.end_reason).toBe('remote_hangup');
    expect(row.duration_seconds).toBeGreaterThanOrEqual(52);
    expect(row.duration_seconds).toBeLessThanOrEqual(54);
  });

  test('answering records who answered, and reaching active keeps that timestamp', async () => {
    const { router, env, DB } = setupWithHistory({
      id: 'call-10', direction: 'inbound', state: 'ringing', iccid: ICCID, number: '92953543',
    });
    DB.seedCall({ id: 'call-10' });
    stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [200, { sessionDescription: { type: 'answer', sdp: 'a' } }],
    });

    await invoke(router, 'POST', '/api/calls/answer', { offer: OFFER, mid: '0' }, env);
    const answeredAt = DB.row('call-10').answered_at;

    // Reaching `active` later must not overwrite the operator's answer time.
    stubSfu({ '/sessions/browser/renegotiate': [200, {}] });
    env.SESSIONS.put(CALL_KEY, JSON.stringify({ ...env.SESSIONS.call(), state: 'bridging' }), {});
    await invoke(router, 'POST', '/api/calls/renegotiate', { answer: { type: 'answer', sdp: 'a' } }, env);

    expect(DB.row('call-10')).toMatchObject({ answered_by: 'auth0|op', answered_at: answeredAt });
  });

  test('an outbound call the daemon could not set up is a failure, not a missed call', async () => {
    const { router, env, DB } = setupWithHistory({ id: 'out-1', direction: 'outbound', state: 'bridging', iccid: ICCID });
    DB.seedCall({ id: 'out-1', direction: 'outbound' });
    stubSfu({});

    await invoke(router, 'POST', '/api/control/calls/ended', { call_id: 'out-1', iccid: ICCID, reason: 'setup_failed' }, env);

    expect(DB.row('out-1')).toMatchObject({ outcome: 'failed', end_reason: 'setup_failed' });
  });

  test('a dial that the SFU refuses is logged as a failed attempt', async () => {
    const { router, env, DB } = setupWithHistory();
    stubSfu({ '/sessions/new': [500, { errorCode: 'boom' }] });

    await invoke(router, 'POST', '/api/calls/dial', { iccid: ICCID, number: '+6592953543', offer: OFFER, mid: '0' }, env);

    const [row] = DB.rows();
    expect(row).toMatchObject({ direction: 'outbound', outcome: 'failed', end_reason: 'sfu_error', remote_number: '+6592953543' });
    expect(row.requested_by).toBe('auth0|op');
  });

  test('whoever reports the end first wins; the second report changes nothing', async () => {
    const { router, env, DB } = setupWithHistory({ id: 'call-11', direction: 'inbound', state: 'active', iccid: ICCID });
    DB.seedCall({ id: 'call-11', answered_at: '2026-09-17T10:00:10.000Z' });
    stubSfu({});

    await invoke(router, 'POST', '/api/control/calls/ended', { call_id: 'call-11', iccid: ICCID, reason: 'remote_hangup' }, env);
    const afterDaemon = DB.row('call-11');
    await invoke(router, 'POST', '/api/calls/hangup', {}, env);

    expect(DB.row('call-11')).toEqual(afterDaemon);
  });

  test('a row left open by a lost end report is swept when the next call starts', async () => {
    const { router, env, DB } = setupWithHistory();
    DB.seedCall({ id: 'orphan', started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });

    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID, from: '92953543' }, env);

    // Never answered, so it reads as missed rather than as a failure.
    expect(DB.row('orphan')).toMatchObject({ outcome: 'missed', end_reason: 'stale' });
    expect(DB.rows()).toHaveLength(2);
  });

  test('a D1 failure never blocks a hangup', async () => {
    const { router, env } = setupWithHistory({ id: 'x', state: 'active', iccid: ICCID, adapters: { up: 'u' } });
    env.DB = { prepare() { throw new Error('D1 unavailable'); } };
    stubSfu({ '/adapters/websocket/close': [200, { tracks: [] }] });

    const response = await invoke(router, 'POST', '/api/calls/hangup', {}, env);

    expect(response.status).toBe(200);
    expect(env.SESSIONS.call()).toBeNull();
  });

  test('history writes are skipped entirely when D1 is not bound', async () => {
    const { router, env } = setup();

    const response = await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env);

    expect(response.status).toBe(200);
  });
});

describe('outcome of a call that never carried audio', () => {
  test('depends on direction and on who ended it', () => {
    expect(unansweredOutcome('inbound', 'daemon', 'missed')).toBe('missed');
    expect(unansweredOutcome('inbound', 'dashboard', 'hangup')).toBe('rejected');
    expect(unansweredOutcome('outbound', 'dashboard', 'hangup')).toBe('cancelled');
    expect(unansweredOutcome('outbound', 'daemon', 'remote_hangup')).toBe('missed');
    expect(unansweredOutcome('outbound', 'daemon', 'setup_failed')).toBe('failed');
    expect(unansweredOutcome('inbound', 'daemon', 'adapter_missing')).toBe('failed');
    expect(unansweredOutcome('outbound', 'worker', 'sfu_error')).toBe('failed');
  });
});

describe('one ring, one row', () => {
  test('repeat reports that both miss the KV lock share a single row', async () => {
    const router = routerStub();
    setupCallRoutes(router);
    const DB = d1Stub();
    const env = envStub({ SESSIONS: staleKvStub(), DB });

    // RING, then the caller id a moment later: with a stale lock both look new.
    const first = await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env);
    const second = await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID, from: '92953543' }, env);

    const rows = DB.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].remote_number).toBe('92953543');
    expect(rows[0].direction).toBe('inbound');
    // Both reports must also agree on the call id the dashboard will see.
    expect((await second.json()).call.id).toBe((await first.json()).call.id);
  });

  test('the two reports still share a row when neither has committed first', async () => {
    const router = routerStub();
    setupCallRoutes(router);
    const DB = d1Stub();
    const env = envStub({ SESSIONS: staleKvStub(), DB });

    // Truly concurrent: the second request starts before the first has written.
    await Promise.all([
      invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env),
      invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID, from: '92953543' }, env),
    ]);

    expect(DB.rows()).toHaveLength(1);
  });

  test('two SIMs ringing at once each get their own row', async () => {
    const router = routerStub();
    setupCallRoutes(router);
    const DB = d1Stub();
    const env = envStub({ SESSIONS: staleKvStub(), DB });

    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env);
    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: '8965030124051507919' }, env);

    expect(DB.rows()).toHaveLength(2);
  });

  test('a later ring on the same SIM is a new call, not a rejoin', async () => {
    const router = routerStub();
    setupCallRoutes(router);
    const DB = d1Stub();
    const env = envStub({ SESSIONS: staleKvStub(), DB });
    DB.seedCall({ id: 'old', iccid: ICCID, outcome: 'missed', started_at: '2026-09-17T09:00:00.000Z' });

    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env);

    expect(DB.rows()).toHaveLength(2);
  });

  test('a ring left open is swept as missed rather than staying in progress', async () => {
    const router = routerStub();
    setupCallRoutes(router);
    const DB = d1Stub();
    const env = envStub({ SESSIONS: staleKvStub(), DB });
    DB.seedCall({
      id: 'abandoned',
      iccid: '8965030124051507919',
      outcome: 'in_progress',
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID }, env);

    const swept = DB.row('abandoned');
    expect(swept.outcome).toBe('missed');
    expect(swept.end_reason).toBe('stale');
    expect(swept.ended_at).not.toBeNull();
  });
});

describe('call history API', () => {
  function seedPage(DB, count) {
    for (let i = 0; i < count; i += 1) {
      DB.seedCall({
        id: `c${String(i).padStart(2, '0')}`,
        direction: i % 2 ? 'outbound' : 'inbound',
        iccid: i % 3 === 0 ? ICCID : '8965030124051507919',
        remote_number: '+6592953543',
        outcome: 'answered',
        started_at: `2026-09-17T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }
  }

  test('returns the newest calls first, enriched with the SIM behind each one', async () => {
    const { router, env, DB } = setupWithHistory();
    DB.seedSim({ iccid: ICCID, number: '+6597817169', carrier: 'Singtel', sim_index: 86 });
    seedPage(DB, 3);

    const response = await invokeGet(router, '/api/calls/history', null, env);

    expect(response.status).toBe(200);
    const { calls, has_more: hasMore } = await response.json();
    expect(hasMore).toBe(false);
    expect(calls.map((call) => call.id)).toEqual(['c02', 'c01', 'c00']);
    expect(calls[2]).toMatchObject({ iccid: ICCID, sim_index: 86, sim_number: '+6597817169', sim_carrier: 'Singtel' });
    // A SIM that is no longer in inventory still lists its calls.
    expect(calls[1]).toMatchObject({ sim_index: null, sim_number: null, sim_carrier: null });
  });

  test('pages with limit and offset and reports whether more remain', async () => {
    const { router, env, DB } = setupWithHistory();
    seedPage(DB, 5);

    const first = await (await invokeGet(router, '/api/calls/history', { limit: '2' }, env)).json();
    const second = await (await invokeGet(router, '/api/calls/history', { limit: '2', offset: '2' }, env)).json();
    const last = await (await invokeGet(router, '/api/calls/history', { limit: '2', offset: '4' }, env)).json();

    expect(first.calls.map((c) => c.id)).toEqual(['c04', 'c03']);
    expect(first.has_more).toBe(true);
    expect(second.calls.map((c) => c.id)).toEqual(['c02', 'c01']);
    expect(last.calls.map((c) => c.id)).toEqual(['c00']);
    expect(last.has_more).toBe(false);
  });

  test('filters to one SIM and clamps an absurd limit', async () => {
    const { router, env, DB } = setupWithHistory();
    seedPage(DB, 6);

    const filtered = await (await invokeGet(router, '/api/calls/history', { iccid: ICCID, limit: '9999' }, env)).json();

    expect(filtered.calls.every((call) => call.iccid === ICCID)).toBe(true);
    expect(filtered.calls).toHaveLength(2);
  });

  test('requires a session', async () => {
    const { router, env } = setupWithHistory();
    const handler = router.routes['GET /api/calls/history'];
    const req = request('/api/calls/history', null, env, { Cookie: '' });

    const response = await handler({ ...req, method: 'GET' }, env, {});

    expect(response.status).toBe(401);
  });
});

describe('authentication', () => {
  test('a wrong daemon API key is rejected before any state is touched', async () => {
    const { router, env } = setup();

    const response = await invoke(router, 'POST', '/api/control/calls/incoming', { iccid: ICCID, from: 'b' }, env, { 'X-API-Key': 'wrong' });

    expect(response.status).toBe(401);
    expect(env.SESSIONS.call()).toBeNull();
  });

  test('a browser route without a session is rejected', async () => {
    const { router, env } = setup();

    const response = await invoke(router, 'POST', '/api/calls/dial', {}, env, { Cookie: '' });

    expect(response.status).toBe(401);
  });
});

describe('route surface', () => {
  test('registers the browser routes and the daemon routes', () => {
    const router = routerStub();
    setupCallRoutes(router);

    expect(Object.keys(router.routes).sort()).toEqual([
      'GET /api/calls/history',
      'GET /api/calls/ice',
      'GET /api/calls/state',
      'POST /api/calls/answer',
      'POST /api/calls/connect',
      'POST /api/calls/dial',
      'POST /api/calls/hangup',
      'POST /api/calls/renegotiate',
      'POST /api/control/calls/ended',
      'POST /api/control/calls/incoming',
    ]);
  });
});
