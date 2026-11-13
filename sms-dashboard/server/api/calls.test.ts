import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { parseJson, readJson, type Schema } from '../../shared/parse-json.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1 } from '../lib/d1.js';
import { CallState } from './call-state.js';
import {
  adapterEndpoint,
  missingConfig,
  setupCallRoutes,
  unansweredOutcome,
  validNumber,
} from './calls.js';

type Router = Parameters<typeof setupCallRoutes>[0];
type CallHandler = Parameters<Router['get']>[1];
type CallRequest = Parameters<CallHandler>[0];
type CallEnv = CallRequest['env'];

const SESSION_TOKEN = 'session-token';
const ICCID = '8965012306052373985';
const OTHER_ICCID = '8965030124051507919';
const OFFER = { type: 'offer', sdp: 'v=0 offer' };
const STARTED_AT = '2026-09-17T10:00:00.000Z';

interface CallFixture {
  id: string;
  direction: 'inbound' | 'outbound';
  state: 'ringing' | 'connecting' | 'bridging' | 'active' | 'ending' | 'ended';
  iccid: string;
  number: string | null;
  started_at: string;
  session_id?: string;
  adapters?: { up?: string; down?: string };
}

function liveCall(fields: Pick<CallFixture, 'id' | 'state'> & Partial<CallFixture>): CallFixture {
  return {
    direction: 'outbound',
    iccid: ICCID,
    number: null,
    started_at: STARTED_AT,
    ...fields,
  };
}

const StoredCall = v.looseObject({ id: v.string(), state: v.string(), iccid: v.string() });
const StoredRecord = v.object({ call: v.unknown(), expiresAt: v.number() });

interface Fleet {
  getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> };
  call(): unknown;
  current(): v.InferOutput<typeof StoredCall>;
  ttl(): number;
  replace(call: unknown): void;
}

function callState(initial: CallFixture | null): Fleet {
  const data = new Map<string, unknown>([['initialized', true]]);
  const object = new CallState(
    {
      storage: {
        kv: {
          get: (key) => data.get(key),
          put: (key, value) => {
            data.set(key, value);
          },
          delete: (key) => {
            data.delete(key);
          },
        },
        transactionSync: (fn) => fn(),
      },
      blockConcurrencyWhile: (fn) => {
        void fn();
      },
    },
    { SESSIONS: { get: () => Promise.resolve(null) } },
  );
  const replace = (call: unknown) => {
    data.set('call', { call, revision: crypto.randomUUID(), expiresAt: Date.now() + 3_600_000 });
  };
  if (initial) replace(initial);
  const call = (): unknown => {
    const stored = v.safeParse(StoredRecord, data.get('call'));
    return stored.success ? stored.output.call : null;
  };
  return {
    getByName: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }),
    call,
    current: () => v.parse(StoredCall, call()),
    ttl: () => Math.round((v.parse(StoredRecord, data.get('call')).expiresAt - Date.now()) / 1000),
    replace,
  };
}

const CallRow = v.looseObject({
  id: v.string(),
  direction: v.string(),
  iccid: v.string(),
  remote_number: v.nullable(v.string()),
  outcome: v.string(),
  end_reason: v.nullable(v.string()),
  started_at: v.string(),
  answered_at: v.nullable(v.string()),
  ended_at: v.nullable(v.string()),
  duration_seconds: v.number(),
  requested_by: v.nullable(v.string()),
  answered_by: v.nullable(v.string()),
});

interface SeededCall {
  id: string;
  direction?: 'inbound' | 'outbound';
  iccid?: string;
  remote_number?: string;
  outcome?: string;
  started_at?: string;
  answered_at?: string;
}

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8');
}

/**
 * Real SQLite running the real migrations, so the call log's SQL (ON CONFLICT, the
 * COALESCE guards, the julianday duration) is under test rather than re-implemented.
 */
function historyDb() {
  const d1 = sqliteD1();
  const { db } = d1;
  db.run(migration('077_add_call_log'));
  db.run(migration('078_one_open_ring_per_sim'));
  db.run('CREATE TABLE device_view (iccid TEXT, number TEXT, carrier TEXT, sim_index INTEGER)');
  return {
    d1,
    rows: () =>
      v.parse(v.array(CallRow), db.query('SELECT * FROM calls ORDER BY started_at, id').all()),
    row: (id: string) => v.parse(CallRow, db.query('SELECT * FROM calls WHERE id = ?').get(id)),
    seedCall: (call: SeededCall) => {
      db.query(
        `INSERT INTO calls (id, direction, iccid, remote_number, outcome, started_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        call.id,
        call.direction ?? 'inbound',
        call.iccid ?? ICCID,
        call.remote_number ?? null,
        call.outcome ?? 'in_progress',
        call.started_at ?? STARTED_AT,
        call.answered_at ?? null,
      );
    },
    seedSim: (sim: { iccid: string; number: string; carrier: string; sim_index: number }) => {
      db.query(
        'INSERT INTO device_view (iccid, number, carrier, sim_index) VALUES (?, ?, ?, ?)',
      ).run(sim.iccid, sim.number, sim.carrier, sim.sim_index);
    },
  };
}

type TestEnv = CallEnv & { CALL_STATE: Fleet; API_KEY: string };

function envStub(CALL_STATE: Fleet, DB: CallEnv['DB']): TestEnv {
  return {
    SESSIONS: {
      get: (key) =>
        Promise.resolve(
          key === SESSION_TOKEN
            ? JSON.stringify({
                expires_at: Date.now() + 60_000,
                user: { id: 'auth0|op', roles: ['admin'] },
              })
            : null,
        ),
      delete: () => Promise.resolve(),
    },
    CALL_STATE,
    REALTIME_APP_ID: 'app',
    REALTIME_APP_SECRET: 'secret',
    TURN_KEY_ID: 'turn',
    TURN_API_TOKEN: 'token',
    VOICE_BRIDGE_HOST: 'voice-bridge.example.test',
    API_KEY: 'daemon-key',
    DB,
  };
}

const unavailableD1: D1 = {
  prepare() {
    throw new Error('D1 unavailable');
  },
};

/**
 * A request the way the router delivers it: the router assigns `request.env`
 * before dispatch. Browser routes authenticate with the auth_token cookie,
 * /api/control/ routes with X-API-Key. A string body is sent as raw text,
 * anything else as its JSON, and `undefined` sends no body at all.
 */
function request(
  env: TestEnv,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  headers: Record<string, string>,
): CallRequest {
  const daemon = path.startsWith('/api/control/');
  const all = new Headers(
    daemon ? { 'x-api-key': env.API_KEY } : { cookie: `auth_token=${SESSION_TOKEN}` },
  );
  all.set('content-type', 'application/json');
  for (const [name, value] of Object.entries(headers)) all.set(name, value);
  const url = `https://example.test${path}`;
  if (method === 'GET') return Object.assign(new Request(url, { headers: all }), { env });
  const text = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
  return Object.assign(new Request(url, { method: 'POST', headers: all, body: text ?? null }), {
    env,
  });
}

function setup(call: CallFixture | null = null, DB?: CallEnv['DB']) {
  const routes = new Map<string, CallHandler>();
  const record = (method: string) => (path: string, handler: CallHandler) => {
    routes.set(`${method} ${path}`, handler);
  };
  const router: Router = { get: record('GET'), post: record('POST') };
  setupCallRoutes(router);

  const db = historyDb();
  const env = envStub(callState(call), DB ?? db.d1);

  function dispatch(method: 'GET' | 'POST', path: string, req: CallRequest) {
    const handler = routes.get(`${method} ${path}`);
    if (handler === undefined) throw new Error(`no route ${method} ${path}`);
    return handler(req);
  }

  return {
    env,
    db,
    routes,
    post: (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      dispatch('POST', path, request(env, 'POST', path, body, headers)),
    get: (path: string, query?: Record<string, string>, headers: Record<string, string> = {}) => {
      const suffix = query ? `?${new URLSearchParams(query).toString()}` : '';
      return dispatch('GET', path, request(env, 'GET', `${path}${suffix}`, undefined, headers));
    },
  };
}

type SfuEntry = readonly [number, unknown] | Response | undefined;
type SfuResponses = Record<string, SfuEntry> | ((path: string, count: number) => SfuEntry);

interface SfuCall {
  path: string;
  method: string | undefined;
  body: unknown;
}

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function stubFetch(handler: (input: string, init: RequestInit | undefined) => Promise<Response>) {
  fetchSpy.mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        if (typeof input !== 'string') throw new TypeError('the Worker fetches by URL string');
        return handler(input, init);
      },
      { preconnect: () => undefined },
    ),
  );
}

/** Records SFU calls and answers them from a path -> response table. */
function stubSfu(responses: SfuResponses): SfuCall[] {
  const calls: SfuCall[] = [];
  stubFetch((url, init) => {
    const path = new URL(url).pathname.replace('/v1/apps/app', '');
    const text = init?.body;
    let body: unknown;
    if (typeof text === 'string') {
      const sent = parseJson(text, v.unknown());
      if (!sent.ok) throw new Error(sent.error);
      body = sent.value;
    }
    calls.push({ path, method: init?.method, body });
    const entry = typeof responses === 'function' ? responses(path, calls.length) : responses[path];
    if (entry instanceof Response) return Promise.resolve(entry);
    const [status, reply] = entry ?? [404, { errorCode: 'not_found' }];
    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  });
  return calls;
}

function sfuCall(calls: SfuCall[], index: number): SfuCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`no SFU call at ${index}`);
  return call;
}

const AdapterRequest = v.object({
  tracks: v.tuple([v.looseObject({ endpoint: v.string() })]),
});

function adapterTrack(call: SfuCall) {
  return v.parse(AdapterRequest, call.body).tracks[0];
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

async function parsed<T>(response: Response, schema: Schema<T>): Promise<T> {
  const result = await readJson(response, schema);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function json(response: Response): Promise<unknown> {
  return parsed(response, v.unknown());
}

const CallIdBody = v.looseObject({ call: v.looseObject({ id: v.string() }) });
const HistoryBody = v.object({
  calls: v.array(v.looseObject({ id: v.string(), iccid: v.string() })),
  has_more: v.boolean(),
});

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
    expect(missingConfig(setup().env)).toEqual([]);
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
      'wss://voice-bridge.itoken.world/voice/11111111-1111-4111-8111-111111111111/up/dial/' +
        '8965012306052373985/%2B6592953543/1800000000/' +
        '2228b401ad42d60138d9f2131e8b4056a77fe21d77ab41810698a0bae6f1e325',
    );
  });

  test('an answer endpoint carries no number, whatever the caller id was', async () => {
    const config = { API_KEY: 'test-key', VOICE_BRIDGE_HOST: 'h' };
    const base = { callId: 'c', leg: 'down', action: 'answer', iccid: ICCID, exp: 1 } as const;
    const a = await adapterEndpoint(config, { ...base, number: '92953543' });
    const b = await adapterEndpoint(config, { ...base, number: null });
    expect(a).toBe(b);
    expect(a.split('/')[8]).toBe('-');
  });
});

describe('outbound media setup', () => {
  const dial = { iccid: ICCID, number: '+6592953543', offer: OFFER, mid: '0' };

  test('dial takes the lock, creates a bodiless session and publishes the mic', async () => {
    const { post, env } = setup();
    const sfu = stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [
        200,
        {
          sessionDescription: { type: 'answer', sdp: 'v=0 answer' },
          tracks: [{ trackName: 'mic', mid: '0' }],
        },
      ],
    });

    const response = await post('/api/calls/dial', dial);

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ answer: { type: 'answer', sdp: 'v=0 answer' } });
    expect(sfu[0]).toEqual({ path: '/sessions/new', method: 'POST', body: undefined });
    expect(sfuCall(sfu, 1).body).toEqual({
      sessionDescription: OFFER,
      tracks: [{ location: 'local', mid: '0', trackName: 'mic' }],
    });
    expect(env.CALL_STATE.call()).toMatchObject({
      direction: 'outbound',
      state: 'connecting',
      session_id: 'browser',
    });
  });

  test('dial accepts the modem ICCID with hex letters and preserves its spelling', async () => {
    const { post, env } = setup();
    const iccid = '896501230605cF73985';
    const sfu = stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [
        200,
        {
          sessionDescription: { type: 'answer', sdp: 'v=0 answer' },
          tracks: [{ trackName: 'mic', mid: '0' }],
        },
      ],
    });

    const invalid = await post('/api/calls/dial', { ...dial, iccid: iccid.replace('c', 'g') });
    expect(invalid.status).toBe(400);
    expect(sfu).toHaveLength(0);

    const response = await post('/api/calls/dial', { ...dial, iccid });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ call: { iccid } });
    expect(env.CALL_STATE.call()).toMatchObject({ iccid });
  });

  test.each(['HTTP error', 'network error'])('an SFU %s releases the lock', async (failure) => {
    const { post, env } = setup();
    stubSfu(() => {
      if (failure === 'network error') throw new TypeError('fetch failed');
      return [500, { errorCode: 'boom' }];
    });

    const response = await post('/api/calls/dial', dial);

    expect(response.status).toBe(502);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('a second dial is refused while any call exists', async () => {
    const { post } = setup(
      liveCall({ id: 'x', direction: 'inbound', state: 'ringing', iccid: 'other' }),
    );
    const sfu = stubSfu({});

    const response = await post('/api/calls/dial', dial);

    expect(response.status).toBe(409);
    expect(sfu).toHaveLength(0);
  });

  test('simultaneous dials publish the microphone for only one call', async () => {
    const { post } = setup();
    const sfu = stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [
        200,
        { sessionDescription: { type: 'answer', sdp: 'answer' } },
      ],
    });
    const responses = await Promise.all([
      post('/api/calls/dial', dial),
      post('/api/calls/dial', dial),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(sfu.filter(({ path }) => path === '/sessions/new')).toHaveLength(1);
  });

  test.each([true, false])(
    'a late SFU response leaves the next call intact (success=%s)',
    async (success) => {
      const { post, env } = setup();
      const entered = Promise.withResolvers<undefined>();
      const resume = Promise.withResolvers<undefined>();
      stubFetch(async (url) => {
        if (url.endsWith('/sessions/new')) {
          entered.resolve(undefined);
          await resume.promise;
          return success
            ? Response.json({ sessionId: 'browser' })
            : Response.json({ errorCode: 'boom' }, { status: 502 });
        }
        return Response.json({ sessionDescription: { type: 'answer', sdp: 'answer' } });
      });
      const pending = post('/api/calls/dial', dial);
      await entered.promise;
      const oldId = env.CALL_STATE.current().id;
      await post('/api/calls/hangup', { call_id: oldId });
      await post('/api/control/calls/incoming', { iccid: ICCID });
      const replacement = env.CALL_STATE.current();
      resume.resolve(undefined);

      expect((await pending).status).toBe(success ? 409 : 502);
      expect(replacement.id).not.toBe(oldId);
      expect(env.CALL_STATE.call()).toEqual(replacement);
    },
  );
});

describe('bridging to the Pi', () => {
  const connecting = liveCall({
    id: 'call-1',
    direction: 'outbound',
    state: 'connecting',
    number: '+6592953543',
    session_id: 'browser',
  });

  test('an empty successful adapter response releases the call for a retry', async () => {
    const { post, env } = setup(connecting);
    stubSfu({ '/adapters/websocket/new': [200, {}] });

    const response = await post('/api/calls/connect', {});

    expect(response.status).toBe(502);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('a successful status without a JSON body is a failure, not a subscribed call', async () => {
    const { post, env } = setup(connecting);
    stubSfu((path, n) => {
      if (path === '/adapters/websocket/new' && n === 1)
        return [200, { tracks: [{ adapterId: 'down-id' }] }];
      if (path === '/adapters/websocket/new')
        return [200, { tracks: [{ adapterId: 'up-id', sessionId: 'modem-session' }] }];
      if (path === '/sessions/browser/tracks/new') return new Response('upstream hiccup');
      return [200, {}];
    });

    const response = await post('/api/calls/connect', {});

    expect(response.status).toBe(502);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('a missing modem session ID closes both known adapters', async () => {
    const { post, env } = setup(connecting);
    const sfu = stubSfu((path, n) =>
      path === '/adapters/websocket/new'
        ? [200, { tracks: [{ adapterId: n === 1 ? 'down' : 'up' }] }]
        : [200, {}],
    );

    const response = await post('/api/calls/connect', {});

    expect(response.status).toBe(502);
    expect(sfu.at(-1)).toMatchObject({
      path: '/adapters/websocket/close',
      body: { tracks: [{ adapterId: 'up' }, { adapterId: 'down' }] },
    });
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('creates both adapters with signed endpoints and pulls the modem track', async () => {
    const { post, env } = setup(connecting);
    const sfu = stubSfu((path, n) => {
      if (path === '/adapters/websocket/new' && n === 1)
        return [200, { tracks: [{ trackName: 'mic', adapterId: 'down-id' }] }];
      if (path === '/adapters/websocket/new')
        return [
          200,
          { tracks: [{ trackName: 'modem', adapterId: 'up-id', sessionId: 'modem-session' }] },
        ];
      if (path === '/sessions/browser/tracks/new') {
        return [
          200,
          {
            requiresImmediateRenegotiation: true,
            sessionDescription: { type: 'offer', sdp: 'v=0 pull' },
            tracks: [{ trackName: 'modem', mid: '1' }],
          },
        ];
      }
      return undefined;
    });

    const response = await post('/api/calls/connect', {});

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ offer: { type: 'offer', sdp: 'v=0 pull' } });

    const down = adapterTrack(sfuCall(sfu, 0));
    expect(down).toMatchObject({
      location: 'remote',
      sessionId: 'browser',
      trackName: 'mic',
      outputCodec: 'pcm',
      mode: 'stream',
    });
    expect(down.endpoint).toMatch(
      /^wss:\/\/voice-bridge\.example\.test\/voice\/call-1\/down\/dial\/8965012306052373985\/%2B6592953543\/\d+\/[0-9a-f]{64}$/,
    );

    const up = adapterTrack(sfuCall(sfu, 1));
    expect(up).toMatchObject({
      location: 'local',
      trackName: 'modem',
      inputCodec: 'pcm',
      mode: 'buffer',
    });
    expect(up.endpoint).toContain('/voice/call-1/up/dial/');

    expect(sfuCall(sfu, 2).body).toEqual({
      tracks: [{ location: 'remote', sessionId: 'modem-session', trackName: 'modem' }],
    });
    expect(env.CALL_STATE.call()).toMatchObject({
      state: 'bridging',
      adapters: { down: 'down-id', up: 'up-id' },
      modem_session_id: 'modem-session',
    });
  });

  test('a per-track adapter error inside a 200 is a failure and closes what was created', async () => {
    const { post, env } = setup(connecting);
    const sfu = stubSfu((path, n) => {
      if (path === '/adapters/websocket/new' && n === 1)
        return [200, { tracks: [{ adapterId: 'down-id' }] }];
      if (path === '/adapters/websocket/new')
        return [200, { tracks: [{ trackName: 'modem', errorCode: 'adapter_unavailable' }] }];
      if (path === '/adapters/websocket/close') return [200, { tracks: [] }];
      return undefined;
    });

    const response = await post('/api/calls/connect', {});

    expect(response.status).toBe(502);
    expect(sfu.at(-1)).toMatchObject({
      path: '/adapters/websocket/close',
      body: { tracks: [{ adapterId: 'down-id' }] },
    });
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('an inbound call signs an answer endpoint', async () => {
    const { post, env } = setup({ ...connecting, direction: 'inbound', number: '92953543' });
    const sfu = stubSfu((path, n) => {
      if (path === '/adapters/websocket/new')
        return [200, { tracks: [{ adapterId: `a${n}`, sessionId: 'modem-session' }] }];
      return [200, { requiresImmediateRenegotiation: false, tracks: [] }];
    });

    const response = await post('/api/calls/connect', {});

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ offer: null });
    expect(adapterTrack(sfuCall(sfu, 0)).endpoint).toContain('/down/answer/8965012306052373985/-/');
    expect(env.CALL_STATE.call()).toMatchObject({ state: 'active' });
  });

  test('connect reads a request without a body as an empty one', async () => {
    const { post, env } = setup(connecting);
    stubSfu({ '/adapters/websocket/new': [200, {}] });

    const response = await post('/api/calls/connect');

    expect(response.status).toBe(502);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('connect without a call answers 404', async () => {
    const { post } = setup();

    const response = await post('/api/calls/connect');

    expect(response.status).toBe(404);
  });

  test('renegotiate applies the browser answer with PUT and marks the call active', async () => {
    const { post, env } = setup({ ...connecting, state: 'bridging' });
    const sfu = stubSfu({ '/sessions/browser/renegotiate': [200, {}] });
    const answer = { type: 'answer', sdp: 'v=0 answer' };

    const response = await post('/api/calls/renegotiate', { answer });

    expect(response.status).toBe(200);
    expect(sfu[0]).toEqual({
      path: '/sessions/browser/renegotiate',
      method: 'PUT',
      body: { sessionDescription: answer },
    });
    expect(env.CALL_STATE.call()).toMatchObject({ state: 'active' });
  });
});

describe('answering and hanging up', () => {
  test('only a ringing inbound call can be answered', async () => {
    const { post } = setup(liveCall({ id: 'x', direction: 'outbound', state: 'active' }));
    stubSfu({});

    const response = await post('/api/calls/answer', { offer: OFFER, mid: '0' });

    expect(response.status).toBe(409);
  });

  test('answering moves the call out of ringing and onto the long TTL', async () => {
    const { post, env } = setup(
      liveCall({ id: 'x', direction: 'inbound', state: 'ringing', number: '92953543' }),
    );
    stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [200, { sessionDescription: { type: 'answer', sdp: 'a' } }],
    });

    const response = await post('/api/calls/answer', { offer: OFFER, mid: '0' });

    expect(response.status).toBe(200);
    expect(env.CALL_STATE.call()).toMatchObject({ state: 'connecting', session_id: 'browser' });
    expect(env.CALL_STATE.ttl()).toBe(3600);
  });

  test('hangup closes the adapters and clears the lock, and is idempotent', async () => {
    const { post, env } = setup(
      liveCall({
        id: 'x',
        direction: 'outbound',
        state: 'active',
        adapters: { up: 'u', down: 'd' },
      }),
    );
    const sfu = stubSfu({ '/adapters/websocket/close': [200, { tracks: [] }] });

    const first = await post('/api/calls/hangup', {});
    const second = await post('/api/calls/hangup', {});

    expect(first.status).toBe(200);
    expect(sfu[0]?.body).toEqual({ tracks: [{ adapterId: 'u' }, { adapterId: 'd' }] });
    expect(env.CALL_STATE.call()).toBeNull();
    expect(await json(second)).toMatchObject({ already_clear: true });
  });

  test('hangup reads a request without a body as an empty one', async () => {
    const { post, env } = setup(liveCall({ id: 'x', direction: 'outbound', state: 'active' }));
    stubSfu({});

    const response = await post('/api/calls/hangup');

    expect(response.status).toBe(200);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('a late hangup for a previous call leaves the current call alone', async () => {
    const active = liveCall({
      id: 'new',
      direction: 'outbound',
      state: 'active',
      adapters: { up: 'u' },
    });
    const { post, env } = setup(active);
    const sfu = stubSfu({});

    const response = await post('/api/calls/hangup', { call_id: 'old' });

    expect(await json(response)).toMatchObject({ already_clear: true });
    expect(env.CALL_STATE.call()).toEqual(active);
    expect(sfu).toHaveLength(0);
  });

  test('a new call created while the old adapters close keeps its lock', async () => {
    const { post, env } = setup(
      liveCall({ id: 'old', direction: 'outbound', state: 'active', adapters: { up: 'u' } }),
    );
    const incoming = liveCall({ id: 'new', direction: 'inbound', state: 'ringing' });
    stubSfu(() => {
      env.CALL_STATE.replace(incoming);
      return [200, { tracks: [] }];
    });

    const response = await post('/api/calls/hangup', { call_id: 'old' });

    expect(await json(response)).toMatchObject({ call: { id: 'old', state: 'ended' } });
    expect(env.CALL_STATE.call()).toEqual(incoming);
  });
});

describe('incoming call reporting from the daemon', () => {
  test('records a ringing call with its caller id on the ring TTL', async () => {
    const { post, env } = setup();

    const response = await post('/api/control/calls/incoming', {
      iccid: ICCID,
      from: '92953543',
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      call: { direction: 'inbound', state: 'ringing', number: '92953543' },
    });
    expect(env.CALL_STATE.call()).toMatchObject({ iccid: ICCID });
    expect(env.CALL_STATE.ttl()).toBe(60);
  });

  test('a repeated RING keeps the same call id', async () => {
    const { post } = setup(liveCall({ id: 'ring-1', direction: 'inbound', state: 'ringing' }));

    const response = await post('/api/control/calls/incoming', {
      iccid: ICCID,
      from: '92953543',
    });

    expect(await json(response)).toMatchObject({ call: { id: 'ring-1' } });
  });

  test('refuses a second ringing modem while a call is active', async () => {
    const { post, env } = setup(
      liveCall({ id: 'x', direction: 'outbound', state: 'active', iccid: 'other' }),
    );

    const response = await post('/api/control/calls/incoming', {
      iccid: '8965012211290057038',
      from: '90421798',
    });

    expect(response.status).toBe(409);
    expect(env.CALL_STATE.call()).toMatchObject({ iccid: 'other' });
  });

  test('rejects a report without an iccid', async () => {
    const { post } = setup();

    const response = await post('/api/control/calls/incoming', { from: '90421798' });

    expect(response.status).toBe(400);
  });
});

describe('end reporting from the daemon', () => {
  test('a matching call id closes the adapters and clears the lock', async () => {
    const { post, env } = setup(
      liveCall({
        id: 'call-1',
        direction: 'outbound',
        state: 'active',
        adapters: { up: 'u' },
      }),
    );
    const sfu = stubSfu({ '/adapters/websocket/close': [200, { tracks: [] }] });

    const response = await post('/api/control/calls/ended', { call_id: 'call-1', iccid: ICCID });

    expect(response.status).toBe(200);
    expect(sfu).toHaveLength(1);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('a ring that stops without a call id clears only a ringing call on that SIM', async () => {
    const { post, env } = setup(liveCall({ id: 'r', direction: 'inbound', state: 'ringing' }));

    const response = await post('/api/control/calls/ended', { iccid: ICCID });

    expect(response.status).toBe(200);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('a stale report for another call is ignored', async () => {
    const { post, env } = setup(
      liveCall({ id: 'current', direction: 'outbound', state: 'active' }),
    );

    const byId = await post('/api/control/calls/ended', { call_id: 'old', iccid: ICCID });
    const byIccid = await post('/api/control/calls/ended', { iccid: ICCID });

    expect(await json(byId)).toMatchObject({ ignored: true });
    expect(await json(byIccid)).toMatchObject({ ignored: true });
    expect(env.CALL_STATE.call()).toMatchObject({ id: 'current' });
  });
});

describe('call history logging', () => {
  test('the first RING opens a row, repeats do not, and a late caller id fills the blank', async () => {
    const { post, env, db } = setup();

    await post('/api/control/calls/incoming', { iccid: ICCID });
    const id = env.CALL_STATE.current().id;
    await post('/api/control/calls/incoming', { iccid: ICCID });
    await post('/api/control/calls/incoming', { iccid: ICCID, from: '92953543' });

    expect(db.rows()).toHaveLength(1);
    expect(db.row(id)).toMatchObject({
      direction: 'inbound',
      iccid: ICCID,
      remote_number: '92953543',
      outcome: 'in_progress',
      duration_seconds: 0,
    });
  });

  test('a blank caller id on the first RING leaves the number for a later RING to fill', async () => {
    const { post, env, db } = setup();

    await post('/api/control/calls/incoming', { iccid: ICCID, from: '' });
    const id = env.CALL_STATE.current().id;
    expect(db.row(id).remote_number).toBeNull();

    await post('/api/control/calls/incoming', { iccid: ICCID, from: '92953543' });

    expect(db.row(id).remote_number).toBe('92953543');
  });

  test('a ring the daemon reports as over is a missed call', async () => {
    const { post, db } = setup(liveCall({ id: 'ring-1', direction: 'inbound', state: 'ringing' }));
    db.seedCall({ id: 'ring-1', remote_number: '92953543' });
    stubSfu({});

    await post('/api/control/calls/ended', { call_id: 'ring-1', iccid: ICCID, reason: 'missed' });

    expect(db.row('ring-1')).toMatchObject({
      outcome: 'missed',
      end_reason: 'missed',
      duration_seconds: 0,
    });
    expect(db.row('ring-1').ended_at).toBeTruthy();
  });

  test('hanging up on a ringing call is a rejection, not a missed call', async () => {
    const { post, db } = setup(liveCall({ id: 'ring-2', direction: 'inbound', state: 'ringing' }));
    db.seedCall({ id: 'ring-2' });
    stubSfu({});

    await post('/api/calls/hangup', {});

    expect(db.row('ring-2')).toMatchObject({ outcome: 'rejected', end_reason: 'hangup' });
  });

  test('an answered call records talk time from the answer, not from the first ring', async () => {
    const { post, db } = setup(liveCall({ id: 'call-9', direction: 'inbound', state: 'active' }));
    db.seedCall({
      id: 'call-9',
      started_at: STARTED_AT,
      answered_at: new Date(Date.now() - 53_000).toISOString(),
    });
    stubSfu({});

    await post('/api/control/calls/ended', {
      call_id: 'call-9',
      iccid: ICCID,
      reason: 'remote_hangup',
    });

    const row = db.row('call-9');
    expect(row.outcome).toBe('answered');
    expect(row.end_reason).toBe('remote_hangup');
    expect(row.duration_seconds).toBeGreaterThanOrEqual(52);
    expect(row.duration_seconds).toBeLessThanOrEqual(54);
  });

  test('answering records who answered, and reaching active keeps that timestamp', async () => {
    const { post, env, db } = setup(
      liveCall({ id: 'call-10', direction: 'inbound', state: 'ringing', number: '92953543' }),
    );
    db.seedCall({ id: 'call-10' });
    stubSfu({
      '/sessions/new': [201, { sessionId: 'browser' }],
      '/sessions/browser/tracks/new': [200, { sessionDescription: { type: 'answer', sdp: 'a' } }],
    });

    await post('/api/calls/answer', { offer: OFFER, mid: '0' });
    const answeredAt = db.row('call-10').answered_at;

    // Reaching `active` later must not overwrite the operator's answer time.
    stubSfu({ '/sessions/browser/renegotiate': [200, {}] });
    env.CALL_STATE.replace({ ...env.CALL_STATE.current(), state: 'bridging' });
    await post('/api/calls/renegotiate', { answer: { type: 'answer', sdp: 'a' } });

    expect(db.row('call-10')).toMatchObject({ answered_by: 'auth0|op', answered_at: answeredAt });
  });

  test('an outbound call the daemon could not set up is a failure, not a missed call', async () => {
    const { post, db } = setup(liveCall({ id: 'out-1', direction: 'outbound', state: 'bridging' }));
    db.seedCall({ id: 'out-1', direction: 'outbound' });
    stubSfu({});

    await post('/api/control/calls/ended', {
      call_id: 'out-1',
      iccid: ICCID,
      reason: 'setup_failed',
    });

    expect(db.row('out-1')).toMatchObject({ outcome: 'failed', end_reason: 'setup_failed' });
  });

  test('a dial that the SFU refuses is logged as a failed attempt', async () => {
    const { post, db } = setup();
    stubSfu({ '/sessions/new': [500, { errorCode: 'boom' }] });

    await post('/api/calls/dial', {
      iccid: ICCID,
      number: '+6592953543',
      offer: OFFER,
      mid: '0',
    });

    const [row] = db.rows();
    expect(row).toMatchObject({
      direction: 'outbound',
      outcome: 'failed',
      end_reason: 'sfu_error',
      remote_number: '+6592953543',
    });
    expect(row?.requested_by).toBe('auth0|op');
  });

  test('whoever reports the end first wins; the second report changes nothing', async () => {
    const { post, db } = setup(liveCall({ id: 'call-11', direction: 'inbound', state: 'active' }));
    db.seedCall({ id: 'call-11', answered_at: '2026-09-17T10:00:10.000Z' });
    stubSfu({});

    await post('/api/control/calls/ended', {
      call_id: 'call-11',
      iccid: ICCID,
      reason: 'remote_hangup',
    });
    const afterDaemon = db.row('call-11');
    await post('/api/calls/hangup', {});

    expect(db.row('call-11')).toEqual(afterDaemon);
  });

  test('a row left open by a lost end report is swept when the next call starts', async () => {
    const { post, db } = setup();
    db.seedCall({
      id: 'orphan',
      started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    await post('/api/control/calls/incoming', { iccid: ICCID, from: '92953543' });

    // Never answered, so it reads as missed rather than as a failure.
    expect(db.row('orphan')).toMatchObject({ outcome: 'missed', end_reason: 'stale' });
    expect(db.rows()).toHaveLength(2);
  });

  test('a D1 failure never blocks a hangup', async () => {
    const { post, env } = setup(
      liveCall({
        id: 'x',
        direction: 'outbound',
        state: 'active',
        adapters: { up: 'u' },
      }),
      unavailableD1,
    );
    stubSfu({ '/adapters/websocket/close': [200, { tracks: [] }] });

    const response = await post('/api/calls/hangup', {});

    expect(response.status).toBe(200);
    expect(env.CALL_STATE.call()).toBeNull();
  });
});

describe('live call state that does not match the schema', () => {
  const unreadable = {
    id: 'x',
    direction: 'outbound',
    state: 'active',
    number: null,
    started_at: STARTED_AT,
  };

  test('the state route throws instead of passing a call without an iccid on', async () => {
    const { get, env } = setup();
    env.CALL_STATE.replace(unreadable);

    const error = await rejection(get('/api/calls/state'));

    expect(error.message).toContain('Live call state is unreadable');
  });

  test('hangup throws instead of clearing a call it cannot read', async () => {
    const { post, env } = setup();
    env.CALL_STATE.replace(unreadable);
    stubSfu({});

    const error = await rejection(post('/api/calls/hangup', {}));

    expect(error.message).toContain('Live call state is unreadable');
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
  test('repeat reports share a single row', async () => {
    const { post, db } = setup();

    // RING, then the caller ID a moment later.
    const first = await post('/api/control/calls/incoming', { iccid: ICCID });
    const second = await post('/api/control/calls/incoming', { iccid: ICCID, from: '92953543' });

    const rows = db.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.remote_number).toBe('92953543');
    expect(rows[0]?.direction).toBe('inbound');
    // Both reports must also agree on the call id the dashboard will see.
    expect((await parsed(second, CallIdBody)).call.id).toBe(
      (await parsed(first, CallIdBody)).call.id,
    );
  });

  test('the two reports still share a row when neither has committed first', async () => {
    const { post, db } = setup();

    // Truly concurrent: the second request starts before the first has written.
    await Promise.all([
      post('/api/control/calls/incoming', { iccid: ICCID }),
      post('/api/control/calls/incoming', { iccid: ICCID, from: '92953543' }),
    ]);

    expect(db.rows()).toHaveLength(1);
  });

  test('a second SIM cannot replace the current ringing call', async () => {
    const { post, env, db } = setup();

    await post('/api/control/calls/incoming', { iccid: ICCID });
    await post('/api/control/calls/incoming', { iccid: OTHER_ICCID });

    expect(db.rows()).toHaveLength(1);
    expect(env.CALL_STATE.call()).toMatchObject({ iccid: ICCID });
  });

  test('a later ring on the same SIM is a new call, not a rejoin', async () => {
    const { post, db } = setup();
    db.seedCall({
      id: 'old',
      iccid: ICCID,
      outcome: 'missed',
      started_at: '2026-09-17T09:00:00.000Z',
    });

    await post('/api/control/calls/incoming', { iccid: ICCID });

    expect(db.rows()).toHaveLength(2);
  });

  test('a ring left open is swept as missed rather than staying in progress', async () => {
    const { post, db } = setup();
    db.seedCall({
      id: 'abandoned',
      iccid: OTHER_ICCID,
      outcome: 'in_progress',
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    await post('/api/control/calls/incoming', { iccid: ICCID });

    const swept = db.row('abandoned');
    expect(swept.outcome).toBe('missed');
    expect(swept.end_reason).toBe('stale');
    expect(swept.ended_at).not.toBeNull();
  });
});

describe('call history API', () => {
  function seedPage(db: ReturnType<typeof historyDb>, count: number) {
    for (let i = 0; i < count; i += 1) {
      db.seedCall({
        id: `c${String(i).padStart(2, '0')}`,
        direction: i % 2 ? 'outbound' : 'inbound',
        iccid: i % 3 === 0 ? ICCID : OTHER_ICCID,
        remote_number: '+6592953543',
        outcome: 'answered',
        started_at: `2026-09-17T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }
  }

  test('returns the newest calls first, enriched with the SIM behind each one', async () => {
    const { get, db } = setup();
    db.seedSim({ iccid: ICCID, number: '+6597817169', carrier: 'Singtel', sim_index: 86 });
    seedPage(db, 3);

    const response = await get('/api/calls/history');

    expect(response.status).toBe(200);
    const { calls, has_more: hasMore } = await parsed(response, HistoryBody);
    expect(hasMore).toBe(false);
    expect(calls.map((call) => call.id)).toEqual(['c02', 'c01', 'c00']);
    expect(calls[2]).toMatchObject({
      iccid: ICCID,
      sim_index: 86,
      sim_number: '+6597817169',
      sim_carrier: 'Singtel',
    });
    // A SIM that is no longer in inventory still lists its calls.
    expect(calls[1]).toMatchObject({ sim_index: null, sim_number: null, sim_carrier: null });
  });

  test('pages with limit and offset and reports whether more remain', async () => {
    const { get, db } = setup();
    seedPage(db, 5);

    const first = await parsed(await get('/api/calls/history', { limit: '2' }), HistoryBody);
    const second = await parsed(
      await get('/api/calls/history', { limit: '2', offset: '2' }),
      HistoryBody,
    );
    const last = await parsed(
      await get('/api/calls/history', { limit: '2', offset: '4' }),
      HistoryBody,
    );

    expect(first.calls.map((c) => c.id)).toEqual(['c04', 'c03']);
    expect(first.has_more).toBe(true);
    expect(second.calls.map((c) => c.id)).toEqual(['c02', 'c01']);
    expect(last.calls.map((c) => c.id)).toEqual(['c00']);
    expect(last.has_more).toBe(false);
  });

  test('filters to one SIM and clamps an absurd limit', async () => {
    const { get, db } = setup();
    seedPage(db, 6);

    const filtered = await parsed(
      await get('/api/calls/history', { iccid: ICCID, limit: '9999' }),
      HistoryBody,
    );

    expect(filtered.calls.every((call) => call.iccid === ICCID)).toBe(true);
    expect(filtered.calls).toHaveLength(2);
  });

  test('requires a session', async () => {
    const { get } = setup();

    const response = await get('/api/calls/history', undefined, { Cookie: '' });

    expect(response.status).toBe(401);
  });
});

describe('ICE servers', () => {
  const ICE = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] };

  test('passes the TURN service credentials through', async () => {
    const { get } = setup();
    stubFetch(() => Promise.resolve(Response.json(ICE)));

    const response = await get('/api/calls/ice');

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(ICE);
  });

  test('a successful status without a JSON body is an upstream failure', async () => {
    const { get } = setup();
    stubFetch(() => Promise.resolve(new Response('upstream hiccup')));

    const response = await get('/api/calls/ice');

    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({ error: 'Could not issue ICE servers' });
  });
});

describe('malformed bodies', () => {
  const ACTIVE = liveCall({ id: 'call-1', state: 'active', direction: 'outbound' });
  const RINGING = liveCall({ id: 'ring-1', state: 'ringing', direction: 'inbound' });
  const CONNECTING = {
    ...ACTIVE,
    state: 'connecting',
    session_id: 'session-1',
  } satisfies CallFixture;
  const BRIDGING = { ...ACTIVE, state: 'bridging', session_id: 'session-1' } satisfies CallFixture;
  const ANSWER = { type: 'answer', sdp: 'v=0 answer' };

  const cases: [string, unknown, CallFixture | null, string][] = [
    ['dial', '{not json', null, 'Body must be JSON'],
    ['dial', 'null', null, 'Body must be a JSON object'],
    ['hangup', 'null', ACTIVE, 'Body must be a JSON object'],
    ['hangup', '[]', ACTIVE, 'Body must be a JSON object'],
    ['connect', { call_id: 5 }, CONNECTING, 'Invalid call ID'],
    ['renegotiate', { answer: ANSWER, call_id: 5 }, BRIDGING, 'Invalid call ID'],
    ['incoming', { iccid: ICCID, from: 5 }, null, 'from must be a string'],
    ['ended', { call_id: 5, iccid: ICCID }, ACTIVE, 'Invalid call ID'],
    ['ended', { iccid: ICCID, reason: 5 }, RINGING, 'reason must be a string'],
    ['ended', { iccid: 5 }, RINGING, 'iccid must be a string'],
  ];

  test.each(cases)(
    '%s answers 400 to %j and leaves the call as it was',
    async (route, body, call, error) => {
      const { post, env } = setup(call);
      const daemon = route === 'incoming' || route === 'ended';
      const path = `/api/${daemon ? 'control/' : ''}calls/${route}`;

      const response = await post(path, body);

      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({ error });
      expect(env.CALL_STATE.call()).toEqual(call);
    },
  );

  test("ended accepts the daemon's null call id for a ring that stopped", async () => {
    const { post, env } = setup(RINGING);

    const response = await post('/api/control/calls/ended', {
      call_id: null,
      iccid: ICCID,
      reason: 'no_carrier',
    });

    expect(response.status).toBe(200);
    expect(env.CALL_STATE.call()).toBeNull();
  });
});

describe('authentication', () => {
  test('a wrong daemon API key is rejected before any state is touched', async () => {
    const { post, env } = setup();

    const response = await post(
      '/api/control/calls/incoming',
      { iccid: ICCID, from: 'b' },
      { 'X-API-Key': 'wrong' },
    );

    expect(response.status).toBe(401);
    expect(env.CALL_STATE.call()).toBeNull();
  });

  test('a browser route without a session is rejected', async () => {
    const { post } = setup();

    const response = await post('/api/calls/dial', {}, { Cookie: '' });

    expect(response.status).toBe(401);
  });
});

describe('route surface', () => {
  test('registers the browser routes and the daemon routes', () => {
    const { routes } = setup();

    expect([...routes.keys()].sort()).toEqual([
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
