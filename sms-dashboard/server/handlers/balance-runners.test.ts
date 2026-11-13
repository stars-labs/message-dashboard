import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createRunnerSchema } from '../../test/runner-schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { auth0Handler } from './auth0.js';
import { balanceRunnersHandler } from './balance-runners.js';

const API_KEY = 'daemon-key';

const HEARTBEAT = {
  runner_id: 'runner-1',
  session_id: 'session-1',
  display_name: 'Runner',
  platform: 'darwin',
  version: '1.0.0',
  capabilities: [{ capability: 'sms_ai', state: 'ready', concurrency: 1 }],
};

const CapabilitySummary = v.object({
  available: v.boolean(),
  state: v.string(),
  runner_id: v.nullable(v.string()),
  current_job_id: v.nullable(v.string()),
  detail_code: v.nullable(v.string()),
  last_heartbeat: v.nullable(v.string()),
});
const StatusBody = v.object({
  success: v.literal(true),
  online_seconds: v.number(),
  capabilities: v.object({ sms_ai: CapabilitySummary, carrier_browser: CapabilitySummary }),
  runners: v.array(
    v.looseObject({
      id: v.string(),
      online: v.boolean(),
      capabilities: v.array(v.looseObject({ capability: v.string() })),
    }),
  ),
});
const ErrorBody = v.object({ error: v.string() });
const CountRow = v.object({ count: v.number() });
const AgeRow = v.object({ age: v.number() });
const OwnerRow = v.object({
  id: v.string(),
  auth_mode: v.string(),
  auth_subject: v.nullable(v.string()),
});
const CapabilityStateRow = v.object({
  capability: v.string(),
  state: v.string(),
  session_id: v.string(),
  concurrency: v.number(),
  current_job_id: v.nullable(v.string()),
});

let sqlite: Database;
let db: ReturnType<typeof sqliteD1>;
let verifySpy: Mock<typeof auth0Handler.verifyToken> | undefined;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createRunnerSchema(sqlite);
  db = sqliteD1(sqlite);
});

afterEach(() => {
  verifySpy?.mockRestore();
  verifySpy = undefined;
  sqlite.close();
});

function heartbeatRequest(
  body: unknown,
  headers: Record<string, string> = { 'X-API-Key': API_KEY },
) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    env: { API_KEY, AUTH0_DOMAIN: 'tenant.example', DB: db },
    headers: new Headers(headers),
    text: () => Promise.resolve(text),
  };
}

/** A device token for `subject` that carries the heartbeat scope. */
function signInDevice(subject: string): Record<string, string> {
  verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue({
    sub: subject,
    scope: 'balance:runners:heartbeat',
  });
  return { Authorization: 'Bearer device-jwt' };
}

async function status(subject: string) {
  const response = await balanceRunnersHandler.status({ env: { DB: db }, user: { id: subject } });
  expect(response.status).toBe(200);
  return v.parse(StatusBody, await response.json());
}

async function errorOf(response: Response): Promise<string> {
  return v.parse(ErrorBody, await response.json()).error;
}

function count(table: string): number {
  return v.parse(CountRow, sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).count;
}

function heartbeatAge(table: string, column: string): number {
  return v.parse(
    AgeRow,
    sqlite
      .query(
        `SELECT CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) AS age
         FROM ${table} WHERE ${column} = 'runner-1'`,
      )
      .get(),
  ).age;
}

describe('runner credential check', () => {
  test('accepts runner credentials without changing control-plane state', async () => {
    const response = await balanceRunnersHandler.check(heartbeatRequest(null));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(count('balance_runner_installations')).toBe(0);
  });

  test('refuses a wrong API key', async () => {
    const response = await balanceRunnersHandler.check(
      heartbeatRequest(null, { 'X-API-Key': 'wrong' }),
    );
    expect(response.status).toBe(401);
  });
});

describe('runner heartbeat', () => {
  test('registers a legacy runner without storing a credential', async () => {
    const response = await balanceRunnersHandler.heartbeat(
      heartbeatRequest({
        ...HEARTBEAT,
        runner_id: ' workstation-legacy ',
        capabilities: [
          { capability: 'sms_ai', state: 'ready', current_job_id: null, detail_code: null },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, runner_id: 'workstation-legacy' });
    expect(
      sqlite.query('SELECT id, auth_mode, auth_subject FROM balance_runner_installations').get(),
    ).toEqual({ id: 'workstation-legacy', auth_mode: 'legacy_api_key', auth_subject: null });
    expect(
      v.parse(
        CapabilityStateRow,
        sqlite
          .query(
            `SELECT capability, state, session_id, concurrency, current_job_id
             FROM balance_runner_capabilities`,
          )
          .get(),
      ),
    ).toEqual({
      capability: 'sms_ai',
      state: 'ready',
      session_id: 'session-1',
      concurrency: 1,
      current_job_id: null,
    });
  });

  test('registers a device runner under its Auth0 subject', async () => {
    const response = await balanceRunnersHandler.heartbeat(
      heartbeatRequest(HEARTBEAT, signInDevice('auth0|alice')),
    );

    expect(response.status).toBe(200);
    expect(
      v.parse(
        OwnerRow,
        sqlite.query('SELECT id, auth_mode, auth_subject FROM balance_runner_installations').get(),
      ),
    ).toEqual({ id: 'runner-1', auth_mode: 'auth0_device', auth_subject: 'auth0|alice' });
  });

  test('updates an existing capability in place', async () => {
    await balanceRunnersHandler.heartbeat(heartbeatRequest(HEARTBEAT));
    const response = await balanceRunnersHandler.heartbeat(
      heartbeatRequest({
        ...HEARTBEAT,
        session_id: 'session-2',
        capabilities: [
          { capability: 'sms_ai', state: 'busy', current_job_id: 'job-7', concurrency: 2 },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(
      sqlite
        .query(
          `SELECT capability, state, session_id, concurrency, current_job_id
           FROM balance_runner_capabilities`,
        )
        .all(),
    ).toEqual([
      {
        capability: 'sms_ai',
        state: 'busy',
        session_id: 'session-2',
        concurrency: 2,
        current_job_id: 'job-7',
      },
    ]);
  });

  test('refreshes installation liveness without rewriting unchanged capabilities', async () => {
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, platform, version, last_heartbeat
      ) VALUES ('runner-1', 'Runner', 'legacy_api_key', 'darwin', '1', datetime('now', '-120 seconds'));
      INSERT INTO balance_runner_capabilities (
        runner_id, capability, state, session_id, last_heartbeat
      ) VALUES ('runner-1', 'sms_ai', 'ready', 'session-1', datetime('now', '-120 seconds'));
    `);

    const response = await balanceRunnersHandler.heartbeat(
      heartbeatRequest({ ...HEARTBEAT, capabilities: [] }),
    );

    expect(response.status).toBe(200);
    expect(heartbeatAge('balance_runner_installations', 'id')).toBeLessThan(5);
    expect(heartbeatAge('balance_runner_capabilities', 'runner_id')).toBeGreaterThanOrEqual(119);
  });

  test('does not let a revoked installation return', async () => {
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, platform, version, revoked_at
      ) VALUES ('runner-1', 'Runner', 'legacy_api_key', 'darwin', '1', CURRENT_TIMESTAMP)
    `);
    const response = await balanceRunnersHandler.heartbeat(heartbeatRequest(HEARTBEAT));
    expect(response.status).toBe(403);
    expect(count('balance_runner_capabilities')).toBe(0);
  });

  test('does not let the legacy credential take over a device-owned runner ID', async () => {
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version
      ) VALUES ('runner-1', 'Runner', 'auth0_device', 'auth0|device-1', 'darwin', '1')
    `);
    const response = await balanceRunnersHandler.heartbeat(heartbeatRequest(HEARTBEAT));
    expect(response.status).toBe(409);
    expect(
      sqlite
        .query(
          "SELECT auth_mode, auth_subject FROM balance_runner_installations WHERE id = 'runner-1'",
        )
        .get(),
    ).toEqual({ auth_mode: 'auth0_device', auth_subject: 'auth0|device-1' });
  });

  test("does not let one device take over another device's runner ID", async () => {
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version
      ) VALUES ('runner-1', 'Runner', 'auth0_device', 'auth0|alice', 'darwin', '1')
    `);
    const response = await balanceRunnersHandler.heartbeat(
      heartbeatRequest(HEARTBEAT, signInDevice('auth0|mallory')),
    );
    expect(response.status).toBe(409);
    expect(count('balance_runner_capabilities')).toBe(0);
  });

  test('refuses a heartbeat without runner credentials', async () => {
    const response = await balanceRunnersHandler.heartbeat(heartbeatRequest(HEARTBEAT, {}));
    expect(response.status).toBe(401);
    expect(count('balance_runner_installations')).toBe(0);
  });

  test('answers 400 to a body that is not JSON', async () => {
    const response = await balanceRunnersHandler.heartbeat(heartbeatRequest('{not json'));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('Body must be JSON');
  });

  const capability = { capability: 'sms_ai', state: 'ready', concurrency: 1 };
  test.each<[string, unknown]>([
    ['a non-object body', []],
    ['a missing runner ID', { ...HEARTBEAT, runner_id: undefined }],
    ['a blank runner ID', { ...HEARTBEAT, runner_id: '   ' }],
    ['an over-long runner ID', { ...HEARTBEAT, runner_id: 'r'.repeat(201) }],
    ['an over-long version', { ...HEARTBEAT, version: 'v'.repeat(101) }],
    ['a missing capability list', { ...HEARTBEAT, capabilities: undefined }],
    [
      'an unknown capability',
      { ...HEARTBEAT, capabilities: [{ ...capability, capability: 'shell' }] },
    ],
    ['an unknown state', { ...HEARTBEAT, capabilities: [{ ...capability, state: 'idle' }] }],
    ['a repeated capability', { ...HEARTBEAT, capabilities: [capability, capability] }],
    ['a blank job ID', { ...HEARTBEAT, capabilities: [{ ...capability, current_job_id: ' ' }] }],
    ['a concurrency above 8', { ...HEARTBEAT, capabilities: [{ ...capability, concurrency: 99 }] }],
    ['a concurrency of 0', { ...HEARTBEAT, capabilities: [{ ...capability, concurrency: 0 }] }],
    [
      'a fractional concurrency',
      { ...HEARTBEAT, capabilities: [{ ...capability, concurrency: 1.5 }] },
    ],
    ['a string concurrency', { ...HEARTBEAT, capabilities: [{ ...capability, concurrency: '2' }] }],
    [
      'a boolean concurrency',
      { ...HEARTBEAT, capabilities: [{ ...capability, concurrency: true }] },
    ],
    ['a null concurrency', { ...HEARTBEAT, capabilities: [{ ...capability, concurrency: null }] }],
    ['an array concurrency', { ...HEARTBEAT, capabilities: [{ ...capability, concurrency: [3] }] }],
  ])('answers 400 to %s', async (_case, body) => {
    const response = await balanceRunnersHandler.heartbeat(heartbeatRequest(body));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('Invalid runner heartbeat');
    expect(count('balance_runner_installations')).toBe(0);
  });
});

describe('runner status', () => {
  test('reports ready capabilities and expires stale heartbeats', async () => {
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version, last_heartbeat
      ) VALUES
        ('online', 'Online', 'auth0_device', 'auth0|alice', 'darwin', '1', CURRENT_TIMESTAMP),
        ('stale', 'Stale', 'auth0_device', 'auth0|alice', 'darwin', '1', datetime('now', '-120 seconds'));
      INSERT INTO balance_runner_capabilities (
        runner_id, capability, state, session_id, detail_code, last_heartbeat
      ) VALUES
        ('online', 'sms_ai', 'ready', 'session-1', NULL, CURRENT_TIMESTAMP),
        ('stale', 'carrier_browser', 'ready', 'session-2', 'login', datetime('now', '-120 seconds'));
    `);

    const body = await status('auth0|alice');
    expect(body.capabilities.sms_ai).toMatchObject({
      available: true,
      state: 'ready',
      runner_id: 'online',
    });
    expect(body.capabilities.carrier_browser).toMatchObject({
      available: false,
      state: 'offline',
      runner_id: 'stale',
      detail_code: 'login',
    });
    expect(body.runners.map(({ id, online }) => ({ id, online }))).toEqual([
      { id: 'online', online: true },
      { id: 'stale', online: false },
    ]);
  });

  test('prefers a ready runner over an online one that is not ready', async () => {
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version
      ) VALUES
        ('a-degraded', 'A', 'auth0_device', 'auth0|alice', 'darwin', '1'),
        ('b-busy', 'B', 'auth0_device', 'auth0|alice', 'darwin', '1');
      INSERT INTO balance_runner_capabilities (runner_id, capability, state, session_id) VALUES
        ('a-degraded', 'sms_ai', 'degraded', 's-a'),
        ('b-busy', 'sms_ai', 'busy', 's-b');
    `);

    const body = await status('auth0|alice');
    expect(body.capabilities.sms_ai).toMatchObject({
      available: true,
      state: 'busy',
      runner_id: 'b-busy',
    });
  });

  test('reports a capability no runner offers as offline', async () => {
    const body = await status('auth0|alice');
    expect(body.capabilities.sms_ai).toEqual({
      available: false,
      state: 'offline',
      runner_id: null,
      current_job_id: null,
      detail_code: null,
      last_heartbeat: null,
    });
    expect(body.runners).toEqual([]);
  });

  test('reports only runners owned by the signed-in subject', async () => {
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version, revoked_at
      ) VALUES
        ('alice', 'Alice Agent', 'auth0_device', 'auth0|alice', 'darwin', '1', NULL),
        ('alice-old', 'Old Agent', 'auth0_device', 'auth0|alice', 'darwin', '1', CURRENT_TIMESTAMP),
        ('bob', 'Bob Agent', 'auth0_device', 'auth0|bob', 'darwin', '1', NULL),
        ('legacy', 'Legacy', 'legacy_api_key', NULL, 'darwin', '1', NULL);
      INSERT INTO balance_runner_capabilities (runner_id, capability, state, session_id) VALUES
        ('alice', 'sms_ai', 'ready', 'alice-session'),
        ('alice-old', 'carrier_browser', 'ready', 'old-session'),
        ('bob', 'carrier_browser', 'ready', 'bob-session'),
        ('legacy', 'carrier_browser', 'ready', 'legacy-session');
    `);

    const body = await status('auth0|alice');
    expect(body.runners.map((runner) => runner.id)).toEqual(['alice']);
    expect(body.capabilities.sms_ai.available).toBe(true);
    expect(body.capabilities.carrier_browser.available).toBe(false);
  });

  test('refuses a request without a signed-in user', async () => {
    const response = await balanceRunnersHandler.status({ env: { DB: db } });
    expect(response.status).toBe(401);
  });
});
