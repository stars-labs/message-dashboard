import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { LATEST_BALANCE_AGENT, LatestBalanceAgent } from '../shared/balance-agent-release.js';
import type { ControlFixture } from '../shared/control-fixtures/fixture.js';
import { callState, type CallFixture, type Fleet } from '../test/call-state-fleet.js';
import { registerRunnerSession } from '../test/runner-session.js';
import { createSchema } from '../test/schema.js';
import { controlFixtures } from '../test/control-fixtures.js';
import { sqliteD1 } from '../test/sqlite-d1.js';
import { callWorker, routeTable, TEST_API_KEY } from '../test/worker-harness.js';

const ICCID = '89860123456789012345';
const SIM_NUMBER = '+8613800000001';
const MENU = '11.账务查询\n12.客户服务';

interface World {
  sqlite: Database;
  fleet: Fleet;
  send(
    method: ControlFixture['request']['method'],
    path: string,
    body?: unknown,
  ): Promise<Response>;
}

interface Answer {
  status: number;
  contentType: string | null;
  pollInterval: string | null;
  text: string;
}

function liveCall(iccid: string, state: CallFixture['state'] = 'ringing'): CallFixture {
  return {
    id: 'call-1',
    direction: 'inbound',
    state,
    iccid,
    number: null,
    started_at: '2026-11-14T23:59:50.000Z',
  };
}

function skillJob({ sqlite }: World): void {
  sqlite
    .query(
      `INSERT INTO messages (id, phone_iccid, phone_number, content, type, status, filter_status, purpose)
     VALUES ('reply-1', ?, '10086', ?, 'received', 'received', 'filtered', 'user')`,
    )
    .run(ICCID, MENU);
  sqlite
    .query(
      `INSERT INTO sim_balance_checks (
       id, sim_iccid, profile_id, status, response_message_id, response_sender, raw_response,
       parser_version, step_index
     ) VALUES ('check-1', ?, 'cn-mobile-sms-menu-v1', 'response_received', 'reply-1', '10086', ?,
       'cn-mobile-balance-v1', 0)`,
    )
    .run(ICCID, MENU);
  sqlite.run(
    `INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index)
     VALUES ('skill-job-1', 'check-1', 'reply-1', 0)`,
  );
}

async function claimedSkillJob(world: World): Promise<void> {
  skillJob(world);
  await world.send('GET', '/api/control/balance-skills/jobs/claim?runner_id=runner-1');
}

function webJob({ sqlite }: World): void {
  sqlite
    .query(
      `INSERT INTO sim_balance_checks (id, sim_iccid, profile_id, status, parser_version)
     VALUES ('check-1', ?, 'cn-unicom-browser-random-password-v1', 'queued', 'cn-unicom-web-balance-v1')`,
    )
    .run(ICCID);
  sqlite.run(
    `INSERT INTO sim_balance_web_jobs (id, check_id, provider)
     VALUES ('web-job-1', 'check-1', 'china_unicom')`,
  );
}

async function claimedWebJob(world: World): Promise<void> {
  webJob(world);
  await world.send('GET', '/api/control/carrier-web-balance/jobs/claim?runner_id=runner-1');
}

async function awaitingOtp(world: World): Promise<void> {
  await claimedWebJob(world);
  await world.send('POST', '/api/control/carrier-web-balance/jobs/web-job-1/otp-requested', {
    runner_id: 'runner-1',
  });
}

function receive(
  { sqlite }: World,
  id: string,
  sender: string,
  content: string,
  code: string,
  at: string,
) {
  sqlite
    .query(
      `INSERT INTO messages (id, phone_iccid, phone_number, content, type, verification_code, created_at)
     VALUES (?, ?, ?, ?, 'received', ?, ${at})`,
    )
    .run(id, ICCID, sender, content, code);
}

function outbound({ sqlite }: World, status: string): void {
  sqlite
    .query(
      `INSERT INTO messages (id, phone_iccid, phone_number, content, type, status, recipient, purpose, created_at)
     VALUES ('outbound-1', ?, ?, 'hello', 'sent', ?, '+8613900000002', 'user', '2026-11-14 23:00:00')`,
    )
    .run(ICCID, SIM_NUMBER, status);
}

// The state each exchange starts from. A fixture without an entry starts from
// one online SIM and nothing else.
const SEEDS: Record<string, (world: World) => void | Promise<void>> = {
  'daemon/pending-sms': (world) => {
    outbound(world, 'sending');
  },
  'daemon/sms-result': (world) => {
    outbound(world, 'processing');
  },
  'daemon/calls-incoming.busy': ({ fleet }) => {
    fleet.replace(liveCall('89860123456789099999', 'active'));
  },
  'daemon/calls-ended': ({ fleet }) => {
    fleet.replace(liveCall(ICCID));
  },
  'runner/balance-skills-claim': skillJob,
  'runner/balance-skills-decision': claimedSkillJob,
  'runner/balance-skills-release': claimedSkillJob,
  'runner/carrier-web-claim': webJob,
  'runner/carrier-web-otp-requested': claimedWebJob,
  'runner/carrier-web-otp': async (world) => {
    await awaitingOtp(world);
    receive(
      world,
      'otp-1',
      '+8610010',
      '您的随机密码为654321，请勿泄露',
      '654321',
      'CURRENT_TIMESTAMP',
    );
  },
  'runner/carrier-web-otp.cursor': async (world) => {
    await awaitingOtp(world);
    world.sqlite.run("UPDATE sim_balance_web_jobs SET otp_requested_at = '2026-11-14 23:59:00'");
    receive(world, 'promo-1', '10010', '优惠码123456', '123456', "'2026-11-15 00:00:00'");
  },
  'runner/carrier-web-otp.empty': awaitingOtp,
  'runner/carrier-web-heartbeat': claimedWebJob,
  'runner/carrier-web-complete': awaitingOtp,
  'runner/carrier-web-fail': claimedWebJob,
  'runner/carrier-web-release': claimedWebJob,
};

async function replay(name: string, request: ControlFixture['request']): Promise<Answer> {
  const sqlite = new Database(':memory:');
  await createSchema(sqlite);
  sqlite
    .query(
      `INSERT INTO sims (iccid, sim_index, phone_number, carrier, country_code, imei)
     VALUES (?, 1, ?, '移动', 'CN', '861234567890123')`,
    )
    .run(ICCID, SIM_NUMBER);
  sqlite.run(
    `INSERT INTO modems (equipment_id, status, detected_iccid)
     VALUES ('861234567890123', 'connected', '${ICCID}')`,
  );
  // Every Balance Agent heartbeats before it claims a job.
  if (name.startsWith('runner/')) registerRunnerSession(sqlite, 'runner-1');
  const fleet = callState(null);
  const bindings = { DB: sqliteD1(sqlite), CALL_STATE: fleet };
  const exchange = async ({ method, path, body, text, anonymous }: ControlFixture['request']) => {
    const sent = body === undefined ? text : JSON.stringify(body);
    const { response } = await callWorker(method, path, {
      headers: {
        ...(anonymous ? {} : { 'X-API-Key': TEST_API_KEY }),
        ...(sent === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(sent === undefined ? {} : { body: sent }),
      bindings,
    });
    return response;
  };
  const send: World['send'] = (method, path, body) => exchange({ method, path, body });
  await SEEDS[name]?.({ sqlite, fleet, send });
  const response = await exchange(request);
  const text = await response.text();
  sqlite.close();
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type'),
    pollInterval: response.headers.get('X-Poll-Interval'),
    text,
  };
}

/** A heartbeat announces the Agent version this Worker ships with; the recording holds a fixed one. */
function asDeployed(
  name: string,
  response: ControlFixture['response'],
): ControlFixture['response'] {
  if (name !== 'runner/balance-runners-heartbeat') return response;
  v.parse(v.looseObject({ latest_agent: LatestBalanceAgent }), response.body);
  const recorded = v.parse(v.record(v.string(), v.unknown()), response.body);
  return {
    ...response,
    body: Object.fromEntries(
      Object.entries(recorded).map(([key, value]) => [
        key,
        key === 'latest_agent' ? LATEST_BALANCE_AGENT : value,
      ]),
    ),
  };
}

function onTheWire({ status, headers, body }: ControlFixture['response']): Answer {
  const pollInterval = headers?.['X-Poll-Interval'] ?? null;
  return body === undefined
    ? { status, contentType: null, pollInterval, text: '' }
    : {
        status,
        contentType: 'application/json;charset=utf-8',
        pollInterval,
        text: JSON.stringify(body),
      };
}

const fixtures = controlFixtures();

let generated = 0;
function next(): number {
  generated += 1;
  return generated;
}

await mock.module('nanoid', () => ({ nanoid: () => `id${String(next())}` }));
beforeEach(() => {
  setSystemTime(new Date('2026-11-15T00:00:00.000Z'));
  generated = 0;
  spyOn(crypto, 'randomUUID').mockImplementation(
    () => `00000000-0000-4000-8000-${String(next()).padStart(12, '0')}`,
  );
});

afterEach(() => {
  setSystemTime();
});

describe('control route fixtures', () => {
  test('every daemon and runner route has a fixture', () => {
    const exercised = fixtures.map(({ fixture: { request } }) => ({
      method: request.method,
      path: new URL(request.path, 'https://worker.test').pathname,
    }));
    const missing = routeTable()
      .filter(({ path }) => path.startsWith('/api/control/'))
      .filter(({ method, path }) => {
        const pattern = new RegExp(`^${path.replaceAll(/:[a-z_]+/g, '[^/]+')}$`);
        return !exercised.some((call) => call.method === method && pattern.test(call.path));
      })
      .map(({ method, path }) => `${method} ${path}`);
    expect(missing).toEqual([]);
  });

  test('every seed belongs to a fixture', () => {
    const names = new Set(fixtures.map(({ name }) => name));
    expect(Object.keys(SEEDS).filter((name) => !names.has(name))).toEqual([]);
  });

  for (const { name, fixture } of fixtures) {
    test(`the Worker answers ${name} as recorded`, async () => {
      expect(await replay(name, fixture.request)).toEqual(
        onTheWire(asDeployed(name, fixture.response)),
      );
    });
  }
});
