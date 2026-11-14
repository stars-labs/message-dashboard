import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { Schema } from '../../shared/parse-json.js';
import { createBalanceSchema } from '../../test/balance-schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch } from '../lib/d1.js';
import {
  balanceQueriesHandler,
  buildBalanceQueryPlan,
  carrierMatchesProfile,
  describeBalanceMethod,
  expectedSenderMatches,
  expireStaleBalanceChecks,
  filterBalancePlanByMethods,
  findPendingBalanceCheck,
  linkBalanceReply,
  mergeMultipartReplies,
  parseBalanceMetrics,
  updateBalanceCheckForSmsResult,
  type BalanceCheckRow,
  type BalanceProfile,
  type PlanPhone,
} from './balance-queries.js';

type TestDb = D1 & D1Batch<'run'>;

const API_KEY = 'secret';
const USER = 'auth0|dashboard-user';
const MOBILE_PROFILE = 'cn-mobile-sms-menu-v1';
const UNICOM_BROWSER_PROFILE = 'cn-unicom-browser-random-password-v1';
const M1_PROFILE = 'sg-m1-prepaid-browser-v1';
const ICCID = '898600520121F0517883';
const NUMBER = '+8613520607015';
const MENU_STEPS = JSON.stringify([
  { response_contains: '1.话费与AI豆', command: '1' },
  { response_contains: '101.查询余额', command: '101' },
]);
const AI_SKILL = JSON.stringify({
  id: 'readonly-balance-menu',
  version: '1',
  objective: '查询当前可用现金话费余额',
  max_turns: 4,
  allowed_currencies: ['CNY'],
});

const ErrorBody = v.object({ success: v.optional(v.literal(false)), error: v.string() });
const Row = v.record(v.string(), v.unknown());
const CountRow = v.object({ count: v.number() });

let sqlite: Database;
let db: TestDb;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createBalanceSchema(sqlite);
  db = sqliteD1(sqlite);
});

afterEach(() => {
  sqlite.close();
});

interface SimSeed {
  iccid: string;
  index: number;
  number?: string;
  carrier?: string;
  country?: string;
  online?: boolean;
  serviceType?: 'prepaid' | 'postpaid';
  role?: 'primary' | 'secondary';
  primary?: string;
}

function insertSim({
  iccid,
  index,
  number = `+86135${String(index).padStart(8, '0')}`,
  carrier = '移动',
  country = 'CN',
  online = true,
  serviceType,
  role,
  primary,
}: SimSeed): void {
  const imei = `imei-${String(index)}`;
  sqlite
    .query(
      `INSERT INTO sims (iccid, sim_index, phone_number, carrier, country_code, imei)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(iccid, index, number, carrier, country, imei);
  sqlite
    .query(`INSERT INTO modems (equipment_id, status, detected_iccid) VALUES (?, ?, ?)`)
    .run(imei, online ? 'connected' : 'disconnected', iccid);
  if (serviceType) {
    sqlite
      .query(
        `UPDATE sims SET service_type = ?, service_type_source = 'carrier_account',
           service_type_verified_at = CURRENT_TIMESTAMP WHERE iccid = ?`,
      )
      .run(serviceType, iccid);
  }
  if (role) {
    sqlite
      .query(`UPDATE sims SET sim_role = ?, primary_iccid = ? WHERE iccid = ?`)
      .run(role, primary ?? null, iccid);
  }
}

/** The China Mobile SMS profile as a fleet-enabled direct query, with the two-step menu. */
function enableDirectMobileProfile(): void {
  sqlite
    .query(
      `UPDATE sim_balance_profiles
       SET enabled = 1, discovery_enabled = 0, skill_config = '{}', conversation_steps = ?
       WHERE id = ?`,
    )
    .run(MENU_STEPS, MOBILE_PROFILE);
}

interface CheckSeed {
  id: string;
  status: string;
  sim?: string;
  profile?: string;
  step?: number;
  requestedAt?: string;
  sentAt?: string | null;
  deadlineAt?: string | null;
  responseMessageId?: string | null;
  responseSender?: string | null;
  rawResponse?: string | null;
  parserVersion?: string;
}

function insertCheck({
  id,
  status,
  sim = ICCID,
  profile = MOBILE_PROFILE,
  step = 0,
  requestedAt = now(),
  sentAt = null,
  deadlineAt = null,
  responseMessageId = null,
  responseSender = null,
  rawResponse = null,
  parserVersion = 'cn-mobile-balance-v1',
}: CheckSeed): void {
  sqlite
    .query(
      `INSERT INTO sim_balance_checks (
         id, sim_iccid, profile_id, status, step_index, requested_at, sent_at, deadline_at,
         response_message_id, response_sender, raw_response, parser_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sim,
      profile,
      status,
      step,
      requestedAt,
      sentAt,
      deadlineAt,
      responseMessageId,
      responseSender,
      rawResponse,
      parserVersion,
    );
}

interface MessageSeed {
  id: string;
  type: 'sent' | 'received';
  content: string;
  timestamp?: string;
  sim?: string;
  number?: string | null;
  recipient?: string | null;
  status?: string;
  checkId?: string | null;
}

function insertMessage({
  id,
  type,
  content,
  timestamp = now(),
  sim = ICCID,
  number = null,
  recipient = null,
  status = type === 'sent' ? 'sent' : 'received',
  checkId = null,
}: MessageSeed): void {
  sqlite
    .query(
      `INSERT INTO messages (
         id, phone_iccid, phone_number, content, timestamp, type, recipient, status,
         filter_status, purpose, balance_check_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'filtered', ?, ?)`,
    )
    .run(
      id,
      sim,
      number,
      content,
      timestamp,
      type,
      recipient,
      status,
      checkId === null ? 'user' : 'balance_maintenance',
      checkId,
    );
}

/** SQLite's datetime('now', modifier), the format D1 stores CURRENT_TIMESTAMP in. */
function now(modifier = '+0 minutes'): string {
  return v.parse(
    v.object({ at: v.string() }),
    sqlite.query(`SELECT datetime('now', ?) AS at`).get(modifier),
  ).at;
}

function one<T>(schema: Schema<T>, sql: string, ...params: (string | number | null)[]): T {
  return v.parse(schema, sqlite.query(sql).get(...params));
}

function every<T>(schema: Schema<T>, sql: string, ...params: (string | number | null)[]): T[] {
  return v.parse(v.array(schema), sqlite.query(sql).all(...params));
}

function count(sql: string, ...params: (string | number | null)[]): number {
  return one(CountRow, sql, ...params).count;
}

async function read<T>(response: Response, schema: Schema<T>): Promise<T> {
  return v.parse(schema, await response.json());
}

async function errorOf(response: Response): Promise<string> {
  return (await read(response, ErrorBody)).error;
}

/** A database the handler must not touch: input validation answers first. */
const untouchable: TestDb = {
  prepare: () => {
    throw new Error('database must not be read');
  },
  batch: () => {
    throw new Error('database must not be written');
  },
};

interface DashboardOptions {
  url?: string;
  method?: string;
  body?: unknown;
  rawBody?: string;
  user?: string | null;
  params?: Record<string, string>;
  database?: TestDb;
}

function dashboardRequest({
  url = 'https://example.com/api/balance-checks',
  method = 'GET',
  body,
  rawBody,
  user = USER,
  params = {},
  database = db,
}: DashboardOptions = {}) {
  const text = rawBody ?? JSON.stringify(body ?? null);
  return {
    url,
    method,
    env: { DB: database },
    ...(user === null ? {} : { user: { id: user } }),
    params,
    text: () => Promise.resolve(text),
  };
}

interface ControlOptions {
  rawBody?: string;
  apiKey?: string;
  database?: TestDb;
  onRead?: () => void;
}

function controlRequest(
  body: unknown,
  { rawBody, apiKey = API_KEY, database = db, onRead }: ControlOptions = {},
) {
  const text = rawBody ?? JSON.stringify(body);
  return {
    headers: new Headers({ 'X-API-Key': apiKey }),
    env: { API_KEY, DB: database },
    text: () => {
      onRead?.();
      return Promise.resolve(text);
    },
  };
}

const PHONE: PlanPhone = {
  iccid: ICCID,
  number: NUMBER,
  carrier: '移动',
  country: 'CN',
  sim_status: 'active',
  sim_index: 1,
  sim_role: 'standalone',
  service_type: 'unknown',
};

const PROFILE: BalanceProfile = {
  id: MOBILE_PROFILE,
  country_code: 'CN',
  carrier: 'China Mobile',
  method: 'sms',
  command: '10086',
  destination: '10086',
  expected_senders: '["10086"]',
  parser_version: 'cn-mobile-balance-v1',
  conversation_steps: MENU_STEPS,
  skill_config: '{}',
  response_window_minutes: 30,
  discovery_enabled: 1,
  enabled: 0,
};

describe('balance-query carrier and sender guards', () => {
  test('recognizes China Mobile aliases without matching other carriers', () => {
    expect(carrierMatchesProfile('移动', 'China Mobile')).toBe(true);
    expect(carrierMatchesProfile('中国移动', 'China Mobile')).toBe(true);
    expect(carrierMatchesProfile('SGP-M1 CMCC', 'China Mobile')).toBe(true);
    expect(carrierMatchesProfile('中国联通', 'China Mobile')).toBe(false);
  });

  test('recognizes China Unicom aliases without matching other carriers', () => {
    expect(carrierMatchesProfile('联通', 'China Unicom')).toBe(true);
    expect(carrierMatchesProfile('中国联通', 'China Unicom')).toBe(true);
    expect(carrierMatchesProfile('UNICOM', 'China Unicom')).toBe(true);
    expect(carrierMatchesProfile('中国移动', 'China Unicom')).toBe(false);
  });

  test('recognizes China Telecom aliases without matching other carriers', () => {
    expect(carrierMatchesProfile('电信', 'China Telecom')).toBe(true);
    expect(carrierMatchesProfile('中国电信', 'China Telecom')).toBe(true);
    expect(carrierMatchesProfile('CTCC', 'China Telecom')).toBe(true);
    expect(carrierMatchesProfile('中国联通', 'China Telecom')).toBe(false);
  });

  test('recognizes CMHK aliases without matching mainland China Mobile', () => {
    expect(carrierMatchesProfile('移动', 'CMHK')).toBe(true);
    expect(carrierMatchesProfile('中国移动香港', 'CMHK')).toBe(true);
    expect(carrierMatchesProfile('China Mobile Hong Kong', 'CMHK')).toBe(true);
    expect(carrierMatchesProfile('SGP-M1 CMCC', 'CMHK')).toBe(false);
  });

  test('matches an unlisted carrier by containment, and never a missing one', () => {
    expect(carrierMatchesProfile('M1 Limited', 'M1')).toBe(true);
    expect(carrierMatchesProfile(null, 'M1')).toBe(false);
    expect(carrierMatchesProfile('  ', 'M1')).toBe(false);
  });

  test('matches only a configured service sender', () => {
    expect(expectedSenderMatches('10086', '["10086"]')).toBe(true);
    expect(expectedSenderMatches('+8610086', '["10086"]')).toBe(true);
    expect(expectedSenderMatches('85212580', '["12580"]')).toBe(true);
    expect(expectedSenderMatches('10086100', '["10086"]')).toBe(false);
    expect(expectedSenderMatches('10086', 'not-json')).toBe(false);
    expect(expectedSenderMatches('10086', '{"sender":"10086"}')).toBe(false);
  });
});

describe('balance query execution requirements', () => {
  test('classifies direct, AI-assisted and browser profiles', () => {
    expect(describeBalanceMethod({ method: 'sms', skill_config: '{}' })).toEqual({
      category: 'direct_sms',
      capability: null,
      interactive: false,
    });
    expect(describeBalanceMethod({ method: 'sms', skill_config: AI_SKILL })).toEqual({
      category: 'sms_ai',
      capability: 'sms_ai',
      interactive: false,
    });
    expect(describeBalanceMethod({ method: 'browser', skill_config: '{}' })).toEqual({
      category: 'browser',
      capability: 'carrier_browser',
      interactive: true,
    });
    expect(describeBalanceMethod(null)).toEqual({
      category: 'unsupported',
      capability: null,
      interactive: false,
    });
  });
});

describe('balance-query planning', () => {
  const enabledProfile: BalanceProfile = { ...PROFILE, enabled: 1, discovery_enabled: 0 };

  test('allows every matching active SIM for an enabled profile', () => {
    const plan = buildBalanceQueryPlan({
      phones: [PHONE, { ...PHONE, iccid: 'second' }],
      profiles: [enabledProfile],
    });
    expect(plan.every((item) => item.eligible)).toBe(true);
  });

  test('selects an enabled browser profile for China Unicom', () => {
    const browserProfile: BalanceProfile = {
      ...enabledProfile,
      id: UNICOM_BROWSER_PROFILE,
      carrier: 'China Unicom',
      method: 'browser',
    };
    const [item] = buildBalanceQueryPlan({
      phones: [{ ...PHONE, carrier: '联通' }],
      profiles: [browserProfile],
    });
    expect(item).toMatchObject({ eligible: true, profile: browserProfile });
  });

  test('prefers an enabled profile over a discovery profile for the same carrier', () => {
    const [item] = buildBalanceQueryPlan({
      phones: [PHONE],
      profiles: [
        { ...PROFILE, id: 'a-discovery' },
        { ...enabledProfile, id: 'z-enabled' },
      ],
      allowDiscovery: true,
    });
    expect(item?.profile?.id).toBe('z-enabled');
  });

  test('enforces a browser profile required service type without changing China profiles', () => {
    const m1Profile: BalanceProfile = {
      ...enabledProfile,
      id: M1_PROFILE,
      country_code: 'SG',
      carrier: 'M1',
      method: 'browser',
      skill_config: JSON.stringify({ required_service_type: 'prepaid' }),
    };
    const plan = buildBalanceQueryPlan({
      phones: [
        { ...PHONE, iccid: 'm1-prepaid', country: 'SG', carrier: 'M1', service_type: 'prepaid' },
        { ...PHONE, iccid: 'm1-postpaid', country: 'SG', carrier: 'M1', service_type: 'postpaid' },
      ],
      profiles: [m1Profile],
    });

    expect(plan[0]).toMatchObject({ eligible: true, reason: null });
    expect(plan[1]).toMatchObject({ eligible: false, reason: 'service_type' });
  });

  test('limits discovery profiles in a batch to SIMs with a parsed result', () => {
    const plan = buildBalanceQueryPlan({
      phones: [PHONE, { ...PHONE, iccid: 'second' }],
      profiles: [PROFILE],
      successfulChecks: [{ sim_iccid: PHONE.iccid, profile_id: PROFILE.id }],
    });
    expect(plan[0]?.eligible).toBe(true);
    expect(plan[1]).toMatchObject({ eligible: false, reason: 'unverified' });
  });

  test('allows an explicit single-SIM discovery query but still enforces cooldown', () => {
    const [available] = buildBalanceQueryPlan({
      phones: [PHONE],
      profiles: [PROFILE],
      allowDiscovery: true,
    });
    const recent = {
      sim_iccid: PHONE.iccid,
      profile_id: PROFILE.id,
      id: 'recent',
      status: 'awaiting_response' as const,
      requested_at: '2026-08-14 01:00:00',
    };
    const [cooldown] = buildBalanceQueryPlan({
      phones: [PHONE],
      profiles: [PROFILE],
      allowDiscovery: true,
      recentChecks: [recent],
    });
    expect(available?.eligible).toBe(true);
    expect(cooldown).toMatchObject({ eligible: false, reason: 'cooldown', recentCheck: recent });
  });

  test('skips offline and unsupported cards with explicit reasons', () => {
    const plan = buildBalanceQueryPlan({
      phones: [
        { ...PHONE, sim_status: 'offline' },
        { ...PHONE, iccid: 'sg', country: 'SG', carrier: 'Singtel' },
      ],
      profiles: [enabledProfile],
    });
    expect(plan.map((item) => item.reason)).toEqual(['offline', 'unsupported']);
  });

  test('marks secondary SIMs ineligible with the secondary reason', () => {
    const plan = buildBalanceQueryPlan({
      phones: [
        { ...PHONE, iccid: 'primary-card', sim_role: 'primary' },
        { ...PHONE, iccid: 'secondary-card', sim_role: 'secondary' },
        { ...PHONE, iccid: 'standalone-card', sim_role: 'standalone' },
      ],
      profiles: [enabledProfile],
    });
    expect(plan[0]).toMatchObject({ eligible: true, reason: null });
    expect(plan[1]).toMatchObject({ eligible: false, reason: 'secondary' });
    expect(plan[2]).toMatchObject({ eligible: true, reason: null });
  });

  test('queues only the explicitly confirmed batch method categories', () => {
    const plan = buildBalanceQueryPlan({
      phones: [
        { ...PHONE, iccid: 'direct', carrier: '移动' },
        { ...PHONE, iccid: 'ai', carrier: '电信' },
        { ...PHONE, iccid: 'browser', carrier: '联通' },
        { ...PHONE, iccid: 'offline', carrier: '移动', sim_status: 'offline' },
      ],
      profiles: [
        enabledProfile,
        { ...enabledProfile, id: 'telecom', carrier: 'China Telecom', skill_config: AI_SKILL },
        { ...enabledProfile, id: 'unicom', carrier: 'China Unicom', method: 'browser' },
      ],
    });
    expect(
      filterBalancePlanByMethods(plan, ['direct_sms', 'sms_ai']).map((item) => item.phone.iccid),
    ).toEqual(['direct', 'ai']);
    expect(filterBalancePlanByMethods(plan, ['browser']).map((item) => item.phone.iccid)).toEqual([
      'browser',
    ]);
  });
});

const PlanSummary = v.object({
  total: v.number(),
  eligible: v.number(),
  offline: v.number(),
  unsupported: v.number(),
  unverified: v.number(),
  cooldown: v.number(),
  secondary: v.number(),
  service_type: v.number(),
});

const CapabilitySummary = v.object({
  available: v.boolean(),
  state: v.string(),
  runner_id: v.nullable(v.string()),
  current_job_id: v.nullable(v.string()),
  detail_code: v.nullable(v.string()),
  last_heartbeat: v.nullable(v.string()),
});

const PreviewBody = v.object({
  success: v.literal(true),
  summary: PlanSummary,
  method_summary: v.object({ direct_sms: v.number(), sms_ai: v.number(), browser: v.number() }),
  runner_capabilities: v.object({ sms_ai: CapabilitySummary, carrier_browser: CapabilitySummary }),
  eligible: v.array(
    v.object({
      phone_iccid: v.string(),
      sim_index: v.number(),
      phone_number: v.string(),
      carrier: v.nullable(v.string()),
      profile_id: v.string(),
      category: v.string(),
      capability: v.nullable(v.string()),
      interactive: v.boolean(),
    }),
  ),
});

describe('/api/balance-checks/query-preview', () => {
  test('plans every SIM on a GET', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: 'sim-1', index: 1 });
    insertSim({ iccid: 'sim-2', index: 2, online: false });
    insertSim({ iccid: 'sim-3', index: 3, carrier: 'Singtel', country: 'SG' });

    const response = await balanceQueriesHandler.preview(dashboardRequest());
    const body = await read(response, PreviewBody);

    expect(response.status).toBe(200);
    expect(body.summary).toEqual({
      total: 3,
      eligible: 1,
      offline: 1,
      unsupported: 1,
      unverified: 0,
      cooldown: 0,
      secondary: 0,
      service_type: 0,
    });
    expect(body.method_summary).toEqual({ direct_sms: 1, sms_ai: 0, browser: 0 });
    expect(body.runner_capabilities.sms_ai).toMatchObject({ available: false, state: 'offline' });
    expect(body.eligible).toEqual([
      {
        phone_iccid: 'sim-1',
        sim_index: 1,
        phone_number: '+8613500000001',
        carrier: '移动',
        profile_id: MOBILE_PROFILE,
        category: 'direct_sms',
        capability: null,
        interactive: false,
      },
    ]);
  });

  test('limits planning to the explicit SIM scope', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: 'sim-1', index: 1 });
    insertSim({ iccid: 'sim-2', index: 2 });
    insertSim({ iccid: 'sim-3', index: 3 });

    const response = await balanceQueriesHandler.preview(
      dashboardRequest({ method: 'POST', body: { phone_iccids: ['sim-1', ' sim-3 '] } }),
    );
    const body = await read(response, PreviewBody);

    expect(response.status).toBe(200);
    expect(body.summary.total).toBe(2);
    expect(body.eligible.map((item) => item.phone_iccid)).toEqual(['sim-1', 'sim-3']);
  });

  test('rejects a POST without a valid scope', async () => {
    for (const body of [{}, { phone_iccids: [] }, { phone_iccids: ['a', 'a'] }, ['sim-1']]) {
      const response = await balanceQueriesHandler.preview(
        dashboardRequest({ method: 'POST', body, database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('A unique non-empty SIM scope is required');
    }
  });

  test('rejects a POST body that is not JSON', async () => {
    const response = await balanceQueriesHandler.preview(
      dashboardRequest({ method: 'POST', rawBody: '{', database: untouchable }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('Invalid JSON body');
  });

  test('requires a signed-in user', async () => {
    const response = await balanceQueriesHandler.preview(
      dashboardRequest({ user: null, database: untouchable }),
    );
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('Unauthorized');
  });
});

const PreflightBody = v.object({
  success: v.literal(true),
  eligible: v.boolean(),
  reason: v.nullable(v.string()),
  phone: v.object({
    iccid: v.string(),
    sim_index: v.number(),
    number: v.string(),
    carrier: v.nullable(v.string()),
  }),
  profile: v.nullable(v.object({ id: v.string(), method: v.string(), carrier: v.string() })),
  method: v.object({
    category: v.string(),
    capability: v.nullable(v.string()),
    interactive: v.boolean(),
  }),
  runner: v.record(v.string(), v.unknown()),
});

function preflightUrl(iccid: string): string {
  return `https://example.com/api/balance-checks/query-preflight?phone_iccid=${encodeURIComponent(iccid)}`;
}

describe('GET /api/balance-checks/query-preflight', () => {
  test('describes an interactive browser query and current runner availability', async () => {
    insertSim({ iccid: ICCID, index: 20, carrier: '联通' });
    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version
      ) VALUES ('runner-1', 'Runner', 'auth0_device', '${USER}', 'darwin', '1');
      INSERT INTO balance_runner_capabilities (runner_id, capability, state, session_id)
      VALUES ('runner-1', 'carrier_browser', 'ready', 'session-1');
    `);

    const response = await balanceQueriesHandler.preflight(
      dashboardRequest({ url: preflightUrl(` ${ICCID} `) }),
    );
    const body = await read(response, PreflightBody);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      eligible: true,
      reason: null,
      phone: { iccid: ICCID, sim_index: 20, carrier: '联通' },
      profile: { id: UNICOM_BROWSER_PROFILE, method: 'browser', carrier: 'China Unicom' },
      method: { category: 'browser', capability: 'carrier_browser', interactive: true },
      runner: { required: true, available: true, state: 'ready', runner_id: 'runner-1' },
    });
  });

  test('needs no runner for a direct SMS query', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: ICCID, index: 1 });

    const response = await balanceQueriesHandler.preflight(
      dashboardRequest({ url: preflightUrl(ICCID) }),
    );
    const body = await read(response, PreflightBody);

    expect(body.method.category).toBe('direct_sms');
    expect(body.runner).toEqual({ required: false, available: true, state: 'not_required' });
  });

  test('reports why a SIM is not eligible', async () => {
    insertSim({ iccid: ICCID, index: 1, carrier: 'Singtel', country: 'SG' });

    const response = await balanceQueriesHandler.preflight(
      dashboardRequest({ url: preflightUrl(ICCID) }),
    );
    const body = await read(response, PreflightBody);

    expect(body).toMatchObject({ eligible: false, reason: 'unsupported', profile: null });
    expect(body.method.category).toBe('unsupported');
  });

  test('requires a SIM that exists', async () => {
    const missing = await balanceQueriesHandler.preflight(
      dashboardRequest({ url: preflightUrl('  ') }),
    );
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe('phone_iccid is required');

    const unknown = await balanceQueriesHandler.preflight(
      dashboardRequest({ url: preflightUrl('nope') }),
    );
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toBe('SIM not found');
  });
});

const QueuedCheck = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  status: v.literal('queued'),
  requested_at: v.string(),
  method: v.string(),
  profile_carrier: v.string(),
  outbound_message_id: v.optional(v.string()),
  web_job_id: v.optional(v.string()),
});

const QueryBody = v.object({ success: v.literal(true), check: QueuedCheck });

const CheckRow = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  status: v.string(),
  step_index: v.number(),
  outbound_message_id: v.nullable(v.string()),
  requested_by_subject: v.nullable(v.string()),
  parser_version: v.string(),
});

const OutboundRow = v.object({
  id: v.string(),
  phone_iccid: v.nullable(v.string()),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  type: v.nullable(v.string()),
  recipient: v.nullable(v.string()),
  status: v.nullable(v.string()),
  filter_status: v.string(),
  purpose: v.string(),
  balance_check_id: v.nullable(v.string()),
});

const OUTBOUND_COLUMNS = `id, phone_iccid, phone_number, content, type, recipient, status,
  filter_status, purpose, balance_check_id`;

describe('POST /api/balance-checks/query', () => {
  test('queues a direct SMS check and its allowlisted outbound message', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: ICCID, index: 1, number: NUMBER });

    const response = await balanceQueriesHandler.query(
      dashboardRequest({ method: 'POST', body: { phone_iccid: ICCID } }),
    );
    const { check } = await read(response, QueryBody);

    expect(response.status).toBe(202);
    expect(check).toMatchObject({
      sim_iccid: ICCID,
      profile_id: MOBILE_PROFILE,
      method: 'sms',
      profile_carrier: 'China Mobile',
    });
    expect(one(CheckRow, `SELECT * FROM sim_balance_checks WHERE id = ?`, check.id)).toEqual({
      id: check.id,
      sim_iccid: ICCID,
      profile_id: MOBILE_PROFILE,
      status: 'queued',
      step_index: 0,
      outbound_message_id: check.outbound_message_id ?? null,
      requested_by_subject: USER,
      parser_version: 'cn-mobile-balance-v1',
    });
    expect(
      one(
        OutboundRow,
        `SELECT ${OUTBOUND_COLUMNS} FROM messages WHERE id = ?`,
        check.outbound_message_id ?? '',
      ),
    ).toEqual({
      id: check.outbound_message_id ?? '',
      phone_iccid: ICCID,
      phone_number: NUMBER,
      content: '10086',
      type: 'sent',
      recipient: '10086',
      status: 'sending',
      filter_status: 'filtered',
      purpose: 'balance_maintenance',
      balance_check_id: check.id,
    });
  });

  test('routes an explicit China Unicom query to the browser profile', async () => {
    insertSim({ iccid: ICCID, index: 1, carrier: '联通' });
    sqlite.run(`
      INSERT INTO sim_balance_profiles (
        id, country_code, carrier, method, command, destination, expected_senders,
        parser_version, discovery_enabled, enabled
      ) VALUES (
        'cn-unicom-sms-cxye-v1', 'CN', 'China Unicom', 'sms', 'CXYE', '10010', '["10010"]',
        'cn-unicom-balance-v1', 1, 0
      );
    `);

    const response = await balanceQueriesHandler.query(
      dashboardRequest({ method: 'POST', body: { phone_iccid: ICCID } }),
    );
    const { check } = await read(response, QueryBody);

    expect(response.status).toBe(202);
    expect(check.profile_id).toBe(UNICOM_BROWSER_PROFILE);
    expect(check.web_job_id).toBeString();
    expect(
      one(CheckRow, `SELECT * FROM sim_balance_checks WHERE id = ?`, check.id).requested_by_subject,
    ).toBe(USER);
    expect(
      count(`SELECT COUNT(*) AS count FROM sim_balance_web_jobs WHERE check_id = ?`, check.id),
    ).toBe(1);
    expect(count(`SELECT COUNT(*) AS count FROM messages`)).toBe(0);
  });

  test('explains why a SIM cannot be queried', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: 'offline', index: 1, online: false });
    insertSim({ iccid: 'unsupported', index: 2, carrier: 'Singtel', country: 'SG' });
    insertSim({ iccid: 'primary', index: 3 });
    insertSim({ iccid: 'secondary', index: 4, role: 'secondary', primary: 'primary' });
    insertSim({ iccid: 'recent', index: 5 });
    insertCheck({ id: 'bal-recent', sim: 'recent', status: 'awaiting_response' });

    const cases = [
      ['offline', 'offline', 409, 'SIM is not active'],
      ['unsupported', 'unsupported', 409, 'No balance query profile matches this SIM'],
      ['secondary', 'secondary', 409, 'SIM is not eligible for a balance query'],
      ['recent', 'cooldown', 429, 'This SIM has already been queried in the last 24 hours'],
    ] as const;
    for (const [iccid, reason, status, error] of cases) {
      const response = await balanceQueriesHandler.query(
        dashboardRequest({ method: 'POST', body: { phone_iccid: iccid } }),
      );
      expect(response.status).toBe(status);
      expect(
        await read(response, v.looseObject({ error: v.string(), reason: v.string() })),
      ).toMatchObject({
        error,
        reason,
      });
    }
  });

  test('returns the previous check that holds a SIM in cooldown', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: ICCID, index: 1 });
    insertCheck({ id: 'bal-recent', status: 'parsed', requestedAt: '2099-01-01 00:00:00' });

    const response = await balanceQueriesHandler.query(
      dashboardRequest({ method: 'POST', body: { phone_iccid: ICCID } }),
    );

    expect(response.status).toBe(429);
    expect(await read(response, v.looseObject({ previous_check: v.unknown() }))).toMatchObject({
      previous_check: {
        sim_iccid: ICCID,
        profile_id: MOBILE_PROFILE,
        id: 'bal-recent',
        status: 'parsed',
        requested_at: '2099-01-01 00:00:00',
      },
    });
  });

  test('answers 404 for an unknown SIM', async () => {
    const response = await balanceQueriesHandler.query(
      dashboardRequest({ method: 'POST', body: { phone_iccid: 'nope' } }),
    );
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe('SIM not found');
  });

  test('rejects a missing or empty phone_iccid instead of planning the whole fleet', async () => {
    for (const body of [{}, { phone_iccid: '' }, { phone_iccid: 7 }, null, ['x']]) {
      const response = await balanceQueriesHandler.query(
        dashboardRequest({ method: 'POST', body, database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await read(response, ErrorBody)).toEqual({
        success: false,
        error: 'phone_iccid is required',
      });
    }
  });

  test('rejects a body that is not JSON', async () => {
    const response = await balanceQueriesHandler.query(
      dashboardRequest({ method: 'POST', rawBody: 'nope', database: untouchable }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('Invalid JSON body');
  });
});

const BatchBody = v.object({
  success: v.literal(true),
  batch_id: v.string(),
  summary: v.object({
    ...PlanSummary.entries,
    selected: v.number(),
    methods: v.array(v.string()),
    queued: v.number(),
    failed_to_queue: v.number(),
  }),
  checks: v.array(QueuedCheck),
  failures: v.array(
    v.object({ phone_iccid: v.string(), sim_index: v.number(), error: v.string() }),
  ),
});

describe('POST /api/balance-checks/query-batch', () => {
  test('rejects absent, duplicate, or unknown method selections before loading the plan', async () => {
    for (const methods of [undefined, [], ['browser', 'browser'], ['ussd'], [1], 'browser']) {
      const response = await balanceQueriesHandler.queryBatch(
        dashboardRequest({
          method: 'POST',
          body: { methods, phone_iccids: [ICCID] },
          database: untouchable,
        }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('A unique list of supported methods is required');
    }
  });

  test('requires a bounded unique SIM scope', async () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => `sim-${String(index)}`);
    for (const phoneIccids of [
      undefined,
      [],
      [ICCID, ICCID],
      [ICCID, ` ${ICCID}`],
      [null],
      ['  '],
      ['x'.repeat(65)],
      tooMany,
    ]) {
      const response = await balanceQueriesHandler.queryBatch(
        dashboardRequest({
          method: 'POST',
          body: { methods: ['browser'], phone_iccids: phoneIccids },
          database: untouchable,
        }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('A unique non-empty SIM scope is required');
    }
  });

  test('checks the methods before the scope, and answers a non-object body about the methods', async () => {
    for (const body of [{}, [], null]) {
      const response = await balanceQueriesHandler.queryBatch(
        dashboardRequest({ method: 'POST', body, database: untouchable }),
      );
      expect(await errorOf(response)).toBe('A unique list of supported methods is required');
    }
  });

  test('plans and queues a batch larger than one D1 statement can bind', async () => {
    enableDirectMobileProfile();
    const iccids = Array.from({ length: 120 }, (_, index) => `sim-${String(index + 1)}`);
    iccids.forEach((iccid, index) => {
      insertSim({ iccid, index: index + 1 });
    });

    const response = await balanceQueriesHandler.queryBatch(
      dashboardRequest({
        method: 'POST',
        body: { methods: ['direct_sms'], phone_iccids: iccids },
      }),
    );
    const body = await read(response, BatchBody);

    expect(response.status).toBe(202);
    expect(body.summary).toMatchObject({ total: 120, eligible: 120, queued: 120 });
    expect(body.checks.map((check) => check.sim_iccid)).toEqual(iccids);
  });

  test('queues every eligible SIM of the selected methods, and reports one that fails', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: 'sim-1', index: 1 });
    insertSim({ iccid: 'sim-2', index: 2 });
    insertSim({ iccid: 'sim-3', index: 3, carrier: '联通' });
    insertSim({ iccid: 'sim-4', index: 4, online: false });
    let batches = 0;
    const flaky: TestDb = {
      prepare: (sql) => db.prepare(sql),
      batch: (statements) => {
        batches += 1;
        return batches === 2 ? Promise.reject(new Error('D1 busy')) : db.batch(statements);
      },
    };

    const response = await balanceQueriesHandler.queryBatch(
      dashboardRequest({
        method: 'POST',
        body: { methods: ['direct_sms'], phone_iccids: ['sim-1', 'sim-2', 'sim-3', 'sim-4'] },
        database: flaky,
      }),
    );
    const body = await read(response, BatchBody);

    expect(response.status).toBe(202);
    expect(body.summary).toEqual({
      total: 4,
      eligible: 2,
      offline: 1,
      unsupported: 0,
      unverified: 1,
      cooldown: 0,
      secondary: 0,
      service_type: 0,
      selected: 2,
      methods: ['direct_sms'],
      queued: 1,
      failed_to_queue: 1,
    });
    expect(body.checks.map((check) => check.sim_iccid)).toEqual(['sim-1']);
    expect(body.failures).toEqual([{ phone_iccid: 'sim-2', sim_index: 2, error: 'D1 busy' }]);
    expect(
      every(v.object({ sim_iccid: v.string() }), `SELECT sim_iccid FROM sim_balance_checks`),
    ).toEqual([{ sim_iccid: 'sim-1' }]);
  });
});

describe('POST /api/control/balance-checks', () => {
  test('rejects an invalid API key before reading the body', async () => {
    let bodyRead = false;
    const response = await balanceQueriesHandler.create(
      controlRequest(
        {},
        { apiKey: 'wrong', database: untouchable, onRead: () => (bodyRead = true) },
      ),
    );
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('Unauthorized');
    expect(bodyRead).toBe(false);
  });

  test('requires a SIM and a profile', async () => {
    for (const body of [{}, { phone_iccid: ICCID }, { phone_iccid: ICCID, profile_id: 1 }, []]) {
      const response = await balanceQueriesHandler.create(
        controlRequest(body, { database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('phone_iccid and profile_id are required');
    }
    const notJson = await balanceQueriesHandler.create(
      controlRequest(null, { rawBody: '{', database: untouchable }),
    );
    expect(await errorOf(notJson)).toBe('Invalid JSON body');
  });

  test('queues only the allowlisted destination and command', async () => {
    insertSim({ iccid: ICCID, index: 1, number: NUMBER });

    const response = await balanceQueriesHandler.create(
      controlRequest({
        phone_iccid: ICCID,
        profile_id: MOBILE_PROFILE,
        destination: '+6599999999',
        command: 'SUBSCRIBE',
      }),
    );
    const { check } = await read(response, QueryBody);

    expect(response.status).toBe(202);
    expect(
      one(CheckRow, `SELECT * FROM sim_balance_checks WHERE id = ?`, check.id).requested_by_subject,
    ).toBeNull();
    expect(
      one(
        OutboundRow,
        `SELECT ${OUTBOUND_COLUMNS} FROM messages WHERE id = ?`,
        check.outbound_message_id ?? '',
      ),
    ).toMatchObject({ phone_number: NUMBER, content: '10086', recipient: '10086' });
  });

  test('creates a browser job without queueing an outbound SMS', async () => {
    insertSim({ iccid: ICCID, index: 1, carrier: '联通' });

    const response = await balanceQueriesHandler.create(
      controlRequest({ phone_iccid: ICCID, profile_id: UNICOM_BROWSER_PROFILE }),
    );
    const { check } = await read(response, QueryBody);

    expect(response.status).toBe(202);
    expect(
      count(`SELECT COUNT(*) AS count FROM sim_balance_web_jobs WHERE check_id = ?`, check.id),
    ).toBe(1);
    expect(count(`SELECT COUNT(*) AS count FROM messages`)).toBe(0);
  });

  test('rejects an offline SIM, an unknown SIM and a SIM from a different carrier', async () => {
    insertSim({ iccid: 'offline', index: 1, online: false });
    insertSim({ iccid: 'unicom', index: 2, carrier: '联通' });

    for (const [iccid, error] of [
      ['offline', 'SIM is not active'],
      ['nope', 'SIM is not active'],
      ['unicom', 'SIM does not match the carrier profile'],
    ] as const) {
      const response = await balanceQueriesHandler.create(
        controlRequest({ phone_iccid: iccid, profile_id: MOBILE_PROFILE }),
      );
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe(error);
    }
    expect(count(`SELECT COUNT(*) AS count FROM sim_balance_checks`)).toBe(0);
  });

  test('enforces the per-SIM 24-hour limit', async () => {
    insertSim({ iccid: ICCID, index: 1 });
    insertCheck({
      id: 'bal-previous',
      status: 'awaiting_response',
      requestedAt: '2026-08-14 01:00:00',
    });

    const response = await balanceQueriesHandler.create(
      controlRequest({ phone_iccid: ICCID, profile_id: MOBILE_PROFILE }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      success: false,
      error: 'This SIM has already been queried in the last 24 hours',
      previous_check: {
        id: 'bal-previous',
        status: 'awaiting_response',
        requested_at: '2026-08-14 01:00:00',
      },
    });
  });

  test('does not count failed, timed-out or day-old attempts against the daily limit', async () => {
    insertSim({ iccid: ICCID, index: 1 });
    insertCheck({ id: 'bal-failed', status: 'failed' });
    insertCheck({ id: 'bal-timed-out', status: 'timed_out' });
    insertCheck({ id: 'bal-old', status: 'parsed', requestedAt: now('-25 hours') });

    const response = await balanceQueriesHandler.create(
      controlRequest({ phone_iccid: ICCID, profile_id: MOBILE_PROFILE }),
    );
    expect(response.status).toBe(202);
  });

  test('accepts only an enabled or discovery profile with an implemented method', async () => {
    insertSim({ iccid: ICCID, index: 1 });
    sqlite.run(`
      UPDATE sim_balance_profiles SET discovery_enabled = 0 WHERE id = '${MOBILE_PROFILE}';
      INSERT INTO sim_balance_profiles (
        id, country_code, carrier, method, command, parser_version, discovery_enabled
      ) VALUES ('cn-mobile-ussd', 'CN', 'China Mobile', 'ussd', '*100#', 'ussd-v1', 1);
    `);

    const disabled = await balanceQueriesHandler.create(
      controlRequest({ phone_iccid: ICCID, profile_id: MOBILE_PROFILE }),
    );
    expect(disabled.status).toBe(404);
    expect(await errorOf(disabled)).toBe('Balance profile is not enabled');

    const ussd = await balanceQueriesHandler.create(
      controlRequest({ phone_iccid: ICCID, profile_id: 'cn-mobile-ussd' }),
    );
    expect(ussd.status).toBe(400);
    expect(await errorOf(ussd)).toBe('Profile method is not implemented');
  });
});

const ListBody = v.object({ success: v.literal(true), data: v.array(Row) });

describe('GET /api/balance-checks', () => {
  test('returns audit records with parsed metrics and the profile outputs', async () => {
    insertSim({ iccid: ICCID, index: 7, number: NUMBER, carrier: 'M1', country: 'SG' });
    insertCheck({
      id: 'bal-1',
      status: 'parsed',
      profile: M1_PROFILE,
      requestedAt: '2026-09-01 10:00:00',
      responseMessageId: 'reply-1',
      responseSender: 'M1',
      rawResponse: 'Balance $5.20',
      parserVersion: 'sg-m1-prepaid-web-balance-v1',
    });
    insertMessage({
      id: 'reply-1',
      type: 'received',
      content: 'Balance $5.20',
      number: 'M1',
      timestamp: '2026-09-01 10:01:00',
    });
    sqlite.run(`
      UPDATE sim_balance_checks SET outbound_message_id = 'sent-1' WHERE id = 'bal-1';
      INSERT INTO sim_balance_metrics (check_id, metric_type, value, unit, currency, expires_at)
      VALUES ('bal-1', 'cash_balance', 5.2, NULL, 'SGD', NULL),
             ('bal-1', 'account_expiry', NULL, NULL, NULL, '2026-12-31');
    `);
    insertMessage({
      id: 'sent-1',
      type: 'sent',
      content: 'login',
      recipient: 'web',
      timestamp: '2026-09-01 10:00:30',
      checkId: 'bal-1',
    });

    const response = await balanceQueriesHandler.list(
      dashboardRequest({
        url: `https://example.com/api/balance-checks?phone_iccid=${ICCID}&limit=25`,
      }),
    );
    const { data } = await read(response, ListBody);

    expect(response.status).toBe(200);
    expect(data).toEqual([
      {
        id: 'bal-1',
        sim_iccid: ICCID,
        profile_id: M1_PROFILE,
        requested_at: '2026-09-01 10:00:00',
        sent_at: null,
        completed_at: null,
        status: 'parsed',
        step_index: 0,
        response_sender: 'M1',
        raw_response: 'Balance $5.20',
        error: null,
        parser_version: 'sg-m1-prepaid-web-balance-v1',
        country_code: 'SG',
        profile_carrier: 'M1',
        method: 'browser',
        command: 'https://mcardaccount.m1.com.sg/login',
        destination: null,
        conversation_steps: '[]',
        sim_index: 7,
        sim_number: NUMBER,
        sim_carrier: 'M1',
        sim_country: 'SG',
        outbound_content: 'login',
        outbound_recipient: 'web',
        outbound_timestamp: '2026-09-01 10:00:30',
        outbound_status: 'sent',
        response_content: 'Balance $5.20',
        response_phone_number: 'M1',
        response_timestamp: '2026-09-01 10:01:00',
        skill_job_status: null,
        web_job_status: null,
        web_human_reason: null,
        display_status: 'parsed',
        profile_outputs: ['cash_balance', 'account_expiry'],
        metrics: [
          {
            metric_type: 'account_expiry',
            value: null,
            unit: null,
            currency: null,
            expires_at: '2026-12-31',
          },
          {
            metric_type: 'cash_balance',
            value: 5.2,
            unit: null,
            currency: 'SGD',
            expires_at: null,
          },
        ],
      },
    ]);
  });

  test('lists the newest checks first, within the clamped limit', async () => {
    insertSim({ iccid: 'sim-1', index: 1 });
    insertSim({ iccid: 'sim-2', index: 2 });
    insertCheck({ id: 'old', sim: 'sim-1', status: 'parsed', requestedAt: '2026-09-01 10:00:00' });
    insertCheck({ id: 'new', sim: 'sim-2', status: 'parsed', requestedAt: '2026-09-02 10:00:00' });

    const ids = async (query: string) =>
      (
        await read(
          await balanceQueriesHandler.list(
            dashboardRequest({ url: `https://example.com/api/balance-checks${query}` }),
          ),
          ListBody,
        )
      ).data.map((check) => check['id']);

    expect(await ids('')).toEqual(['new', 'old']);
    expect(await ids('?limit=0')).toEqual(['new']);
    expect(await ids('?limit=abc')).toEqual(['new', 'old']);
    expect(await ids('?phone_iccid=sim-1')).toEqual(['old']);
  });

  test('shows a check whose runtime skill or web job is still working', async () => {
    insertSim({ iccid: 'sim-1', index: 1 });
    insertSim({ iccid: 'sim-2', index: 2 });
    insertSim({ iccid: 'sim-3', index: 3 });
    insertCheck({
      id: 'skill',
      sim: 'sim-1',
      status: 'response_received',
      responseMessageId: 'reply',
    });
    insertMessage({ id: 'reply', type: 'received', content: '11.账务查询', sim: 'sim-1' });
    insertCheck({ id: 'web', sim: 'sim-2', status: 'queued', profile: UNICOM_BROWSER_PROFILE });
    insertCheck({
      id: 'web-done',
      sim: 'sim-3',
      status: 'queued',
      profile: UNICOM_BROWSER_PROFILE,
    });
    sqlite.run(`
      INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index, status)
      VALUES ('job', 'skill', 'reply', 0, 'leased');
      INSERT INTO sim_balance_web_jobs (id, check_id, provider, status, human_reason)
      VALUES ('wj', 'web', 'china_unicom', 'human_verification_required', 'slider'),
             ('wj-done', 'web-done', 'china_unicom', 'completed', NULL);
    `);

    const { data } = await read(await balanceQueriesHandler.list(dashboardRequest()), ListBody);
    const byId = new Map(data.map((check) => [check['id'], check]));

    expect(byId.get('skill')).toMatchObject({
      skill_job_status: 'leased',
      display_status: 'skill_processing',
    });
    expect(byId.get('web')).toMatchObject({
      web_job_status: 'human_verification_required',
      web_human_reason: 'slider',
      display_status: 'web_human_required',
    });
    expect(byId.get('web-done')).toMatchObject({ display_status: 'queued' });
  });
});

const StatusBody = v.object({ success: v.literal(true), data: v.array(Row) });

describe('GET /api/balance-checks/status', () => {
  test('returns lightweight status for only the requested checks', async () => {
    insertSim({ iccid: 'sim-1', index: 1 });
    insertSim({ iccid: 'sim-2', index: 2 });
    insertSim({ iccid: 'sim-3', index: 3 });
    insertCheck({ id: 'bal-1', sim: 'sim-1', status: 'queued', profile: UNICOM_BROWSER_PROFILE });
    insertCheck({ id: 'bal-2', sim: 'sim-2', status: 'unparsed', responseMessageId: 'reply' });
    insertMessage({ id: 'reply', type: 'received', content: 'menu', sim: 'sim-2' });
    insertCheck({ id: 'bal-3', sim: 'sim-3', status: 'parsed' });
    sqlite.run(`
      INSERT INTO sim_balance_web_jobs (id, check_id, provider, status)
      VALUES ('wj', 'bal-1', 'china_unicom', 'awaiting_otp');
      INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index)
      VALUES ('job', 'bal-2', 'reply', 0);
      UPDATE sim_balance_checks SET updated_at = '2026-09-04 10:00:00';
    `);

    const response = await balanceQueriesHandler.status(
      dashboardRequest({
        url: 'https://example.com/api/balance-checks/status?ids=bal-1, bal-2,bal-1,,',
      }),
    );
    const { data } = await read(response, StatusBody);

    expect(data).toHaveLength(2);
    expect(new Map(data.map((check) => [check['id'], check]))).toEqual(
      new Map([
        [
          'bal-1',
          {
            id: 'bal-1',
            status: 'queued',
            updated_at: '2026-09-04 10:00:00',
            completed_at: null,
            skill_job_status: null,
            web_job_status: 'awaiting_otp',
            web_human_reason: null,
            display_status: 'web_otp',
          },
        ],
        [
          'bal-2',
          {
            id: 'bal-2',
            status: 'unparsed',
            updated_at: '2026-09-04 10:00:00',
            completed_at: null,
            skill_job_status: 'pending',
            web_job_status: null,
            web_human_reason: null,
            display_status: 'skill_pending',
          },
        ],
      ]),
    );
  });

  test('requires between 1 and 100 short ids', async () => {
    const tooMany = Array.from({ length: 101 }, (_, index) => `bal-${String(index)}`).join(',');
    for (const ids of ['', ' , ', tooMany, 'x'.repeat(201)]) {
      const response = await balanceQueriesHandler.status(
        dashboardRequest({
          url: `https://example.com/api/balance-checks/status?ids=${ids}`,
          database: untouchable,
        }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('ids must contain 1 to 100 balance check IDs');
    }
  });
});

const DetailBody = v.object({
  success: v.literal(true),
  data: v.object({ id: v.string(), conversation: v.array(Row), web_events: v.array(Row) }),
});

describe('GET /api/balance-checks/:id', () => {
  test('loads the conversation and web events of one check', async () => {
    insertSim({ iccid: ICCID, index: 1, number: NUMBER });
    insertCheck({ id: 'bal-1', status: 'queued', profile: UNICOM_BROWSER_PROFILE });
    insertMessage({
      id: 'out',
      type: 'sent',
      content: '10086',
      recipient: '10086',
      number: NUMBER,
      timestamp: '2026-09-01 10:00:00',
      checkId: 'bal-1',
    });
    insertMessage({
      id: 'in',
      type: 'received',
      content: '余额 10 元',
      number: '10086',
      timestamp: '2026-09-01 10:01:00',
      checkId: 'bal-1',
    });
    insertMessage({ id: 'unrelated', type: 'received', content: 'hi' });
    sqlite.run(`
      INSERT INTO sim_balance_web_jobs (id, check_id, provider) VALUES ('wj', 'bal-1', 'china_unicom');
      INSERT INTO sim_balance_web_events (job_id, event_type, detail_json, created_at)
      VALUES ('wj', 'claimed', '{"runner":"r1"}', '2026-09-01 10:00:05');
    `);

    const response = await balanceQueriesHandler.detail(
      dashboardRequest({ params: { id: ' bal-1 ' } }),
    );
    const body = await read(response, DetailBody);

    expect(body.data).toEqual({
      id: 'bal-1',
      conversation: [
        {
          id: 'out',
          type: 'sent',
          content: '10086',
          timestamp: '2026-09-01 10:00:00',
          status: 'sent',
          phone_number: NUMBER,
          recipient: '10086',
        },
        {
          id: 'in',
          type: 'received',
          content: '余额 10 元',
          timestamp: '2026-09-01 10:01:00',
          status: 'received',
          phone_number: '10086',
          recipient: null,
        },
      ],
      web_events: [
        {
          id: 1,
          event_type: 'claimed',
          detail_json: '{"runner":"r1"}',
          created_at: '2026-09-01 10:00:05',
        },
      ],
    });
  });

  test('answers 400 for a bad id and 404 for an unknown one', async () => {
    for (const params of [{}, { id: '  ' }, { id: 'x'.repeat(201) }]) {
      const response = await balanceQueriesHandler.detail(
        dashboardRequest({ params, database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('Invalid balance check ID');
    }
    const missing = await balanceQueriesHandler.detail(
      dashboardRequest({ params: { id: 'nope' } }),
    );
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toBe('Balance check not found');
  });
});

/** A sent balance check on the China Mobile menu profile, as findPendingBalanceCheck reads it. */
async function pendingCheck(seed: Partial<CheckSeed> & { id: string }): Promise<BalanceCheckRow> {
  insertCheck({
    status: 'awaiting_response',
    sentAt: now('-1 minutes'),
    deadlineAt: now('+29 minutes'),
    ...seed,
  });
  const check = await findPendingBalanceCheck(db, {
    phone_iccid: seed.sim ?? ICCID,
    phone_number: '10086',
  });
  if (check?.id !== seed.id) throw new Error(`check ${seed.id} is not pending`);
  return check;
}

const BalanceCheckState = v.object({
  status: v.string(),
  step_index: v.number(),
  response_message_id: v.nullable(v.string()),
  response_sender: v.nullable(v.string()),
  raw_response: v.nullable(v.string()),
  error: v.nullable(v.string()),
  sent_at: v.nullable(v.string()),
  deadline_at: v.nullable(v.string()),
  completed_at: v.nullable(v.string()),
});

function checkState(id: string) {
  return one(
    BalanceCheckState,
    `SELECT status, step_index, response_message_id, response_sender, raw_response, error,
       sent_at, deadline_at, completed_at
     FROM sim_balance_checks WHERE id = ?`,
    id,
  );
}

describe('balance reply correlation', () => {
  beforeEach(() => {
    insertSim({ iccid: ICCID, index: 1, number: NUMBER });
    sqlite
      .query(`UPDATE sim_balance_profiles SET conversation_steps = ? WHERE id = ?`)
      .run(MENU_STEPS, MOBILE_PROFILE);
  });

  test('selects the newest pending check whose sender allowlist matches', async () => {
    sqlite.run(`
      INSERT INTO sim_balance_profiles (
        id, country_code, carrier, method, command, destination, expected_senders, parser_version
      ) VALUES ('cn-unicom-sms', 'CN', 'China Unicom', 'sms', 'CXYE', '10010', '["10010"]', 'u-v1');
    `);
    insertCheck({
      id: 'matching',
      status: 'failed',
      requestedAt: now('-3 minutes'),
      deadlineAt: now('+27 minutes'),
    });
    insertCheck({
      id: 'newest',
      status: 'awaiting_response',
      profile: 'cn-unicom-sms',
      requestedAt: now('-1 minutes'),
      deadlineAt: now('+29 minutes'),
    });

    const match = await findPendingBalanceCheck(db, {
      phone_iccid: ICCID,
      phone_number: '+8610086',
    });
    const { skill_config } = one(
      v.object({ skill_config: v.string() }),
      `SELECT skill_config FROM sim_balance_profiles WHERE id = ?`,
      MOBILE_PROFILE,
    );

    expect(match).toEqual({
      id: 'matching',
      sim_iccid: ICCID,
      profile_id: MOBILE_PROFILE,
      parser_version: 'cn-mobile-balance-v1',
      step_index: 0,
      status: 'failed',
      expected_senders: '["10086"]',
      conversation_steps: MENU_STEPS,
      skill_config,
      destination: '10086',
      sim_number: NUMBER,
      response_window_open: 1,
    });
  });

  test('correlates by SMS receive time and can recover a terminal check', async () => {
    insertCheck({
      id: 'timed-out',
      status: 'timed_out',
      requestedAt: '2026-08-24 07:48:54',
      deadlineAt: '2026-08-24 08:18:54',
    });
    insertMessage({
      id: 'sent',
      type: 'sent',
      content: '10086',
      timestamp: '2026-08-24 07:49:00',
      checkId: 'timed-out',
    });

    const find = (timestamp: string) =>
      findPendingBalanceCheck(db, {
        phone_iccid: ICCID,
        phone_number: '10086',
        message_timestamp: timestamp,
      });

    expect((await find('2026-08-24T07:49:22.000Z'))?.id).toBe('timed-out');
    expect((await find('2026-08-24T07:49:22.000Z'))?.response_window_open).toBe(0);
    expect(await find('2026-08-24T07:48:58.000Z')).toBeNull();
    expect(await find('2026-08-24T08:19:00.000Z')).toBeNull();
  });

  test('never correlates a reply without a SIM, a sender, or a matching status', async () => {
    insertCheck({ id: 'parsed', status: 'parsed', deadlineAt: now('+29 minutes') });

    expect(
      await findPendingBalanceCheck(db, { phone_iccid: ICCID, phone_number: '10086' }),
    ).toBeNull();
    expect(
      await findPendingBalanceCheck(untouchable, { phone_iccid: '', phone_number: '10086' }),
    ).toBeNull();
    expect(
      await findPendingBalanceCheck(untouchable, { phone_iccid: ICCID, phone_number: '' }),
    ).toBeNull();
  });

  test('moves a queued check to awaiting_response after SMS success', async () => {
    for (const outcome of ['confirmed', 'submitted_unconfirmed'] as const) {
      sqlite.run(`DELETE FROM messages; DELETE FROM sim_balance_checks;`);
      insertCheck({ id: 'bal-1', status: 'queued' });
      insertMessage({
        id: 'msg-1',
        type: 'sent',
        content: '10086',
        checkId: 'bal-1',
        status: 'sending',
      });

      await updateBalanceCheckForSmsResult(db, 'msg-1', outcome);

      const state = checkState('bal-1');
      expect(state).toMatchObject({ status: 'awaiting_response', error: null, completed_at: null });
      expect(state.sent_at).toBeString();
      expect(state.deadline_at).toBe(
        one(v.object({ at: v.string() }), `SELECT datetime(?, '+30 minutes') AS at`, state.sent_at)
          .at,
      );
    }
  });

  test('fails a queued check only after an explicit SMS submission failure', async () => {
    insertCheck({ id: 'bal-1', status: 'queued' });
    insertMessage({
      id: 'msg-1',
      type: 'sent',
      content: '10086',
      checkId: 'bal-1',
      status: 'sending',
    });

    await updateBalanceCheckForSmsResult(db, 'msg-1', 'failed', 'explicit modem error');

    expect(checkState('bal-1')).toMatchObject({
      status: 'failed',
      error: 'explicit modem error',
      sent_at: null,
      deadline_at: null,
    });
    expect(checkState('bal-1').completed_at).toBeString();
  });

  test('records a generic error for a failure without one, and leaves a non-queued check alone', async () => {
    insertCheck({ id: 'bal-1', status: 'queued' });
    insertMessage({
      id: 'msg-1',
      type: 'sent',
      content: '10086',
      checkId: 'bal-1',
      status: 'sending',
    });
    await updateBalanceCheckForSmsResult(db, 'msg-1', 'failed');
    expect(checkState('bal-1').error).toBe('SMS send failed');

    sqlite.run(`UPDATE sim_balance_checks SET status = 'queued', error = NULL`);
    await updateBalanceCheckForSmsResult(db, 'msg-1', 'failed', '');
    expect(checkState('bal-1').error).toBe('SMS send failed');

    await updateBalanceCheckForSmsResult(db, 'msg-1', 'confirmed');
    expect(checkState('bal-1').status).toBe('failed');
  });

  test('queues only the allowlisted menu response as the next audited SMS', async () => {
    const check = await pendingCheck({ id: 'bal-menu' });
    insertMessage({
      id: 'msg-menu',
      type: 'received',
      content: '0.业务查询与退订\n1.话费与AI豆\n2.最新活动',
      number: '10086',
    });

    const result = await linkBalanceReply(db, check, {
      id: 'msg-menu',
      phone_number: '10086',
      content: '0.业务查询与退订\n1.话费与AI豆\n2.最新活动',
    });

    const sent = every(
      OutboundRow,
      `SELECT ${OUTBOUND_COLUMNS} FROM messages WHERE type = 'sent' AND balance_check_id = ?`,
      'bal-menu',
    );
    expect(result).toEqual({ queued: true, message_id: sent[0]?.id ?? null });
    expect(checkState('bal-menu')).toMatchObject({
      status: 'queued',
      step_index: 1,
      response_message_id: 'msg-menu',
      response_sender: '10086',
      raw_response: '0.业务查询与退订\n1.话费与AI豆\n2.最新活动',
      deadline_at: null,
    });
    expect(sent).toMatchObject([
      {
        phone_iccid: ICCID,
        phone_number: NUMBER,
        content: '1',
        type: 'sent',
        recipient: '10086',
        status: 'sending',
        filter_status: 'filtered',
        purpose: 'balance_maintenance',
        balance_check_id: 'bal-menu',
      },
    ]);
  });

  test('queues the discovered 101 command from the second-level menu', async () => {
    const check = await pendingCheck({ id: 'bal-submenu', step: 1 });

    await linkBalanceReply(db, check, {
      id: 'msg-submenu',
      phone_number: '10086',
      content: '101.查询余额\n102.查询实时话费\n106.话费账单',
    });

    expect(checkState('bal-submenu').step_index).toBe(2);
    expect(
      every(v.object({ content: v.string() }), `SELECT content FROM messages WHERE type = 'sent'`),
    ).toEqual([{ content: '101' }]);
  });

  test('does not follow a menu once follow-ups are disallowed or the reply window closed', async () => {
    const menu = { id: 'msg-menu', phone_number: '10086', content: '1.话费与AI豆' };
    const check = await pendingCheck({ id: 'bal-menu' });

    await linkBalanceReply(db, { ...check, response_window_open: 0 }, menu);
    expect(checkState('bal-menu').status).toBe('response_received');
    expect(count(`SELECT COUNT(*) AS count FROM messages WHERE type = 'sent'`)).toBe(0);
  });

  test('parses a final China Mobile balance and stores a typed metric', async () => {
    const check = await pendingCheck({ id: 'bal-final', step: 2 });
    insertMessage({
      id: 'msg-final',
      type: 'received',
      content: '尊敬的客户，您的账户余额为82.36元。',
      number: '10086',
    });

    const result = await linkBalanceReply(db, check, {
      id: 'msg-final',
      phone_number: '10086',
      content: '尊敬的客户，您的账户余额为82.36元。',
    });

    expect(result).toMatchObject({ linked: true });
    expect(checkState('bal-final')).toMatchObject({
      status: 'parsed',
      response_message_id: 'msg-final',
      raw_response: '尊敬的客户，您的账户余额为82.36元。',
      error: null,
    });
    expect(
      every(
        Row,
        `SELECT check_id, metric_type, value, unit, currency, expires_at FROM sim_balance_metrics`,
      ),
    ).toEqual([
      {
        check_id: 'bal-final',
        metric_type: 'cash_balance',
        value: 82.36,
        unit: null,
        currency: 'CNY',
        expires_at: null,
      },
    ]);
    expect(
      one(
        v.object({ purpose: v.string(), balance_check_id: v.nullable(v.string()) }),
        `SELECT purpose, balance_check_id FROM messages WHERE id = 'msg-final'`,
      ),
    ).toEqual({ purpose: 'balance_maintenance', balance_check_id: 'bal-final' });
  });

  test('parses the merged text of a multipart reply', async () => {
    const check = await pendingCheck({ id: 'bal-merged', step: 2 });

    await linkBalanceReply(
      db,
      check,
      { id: 'part-1', phone_number: '10086', content: '国移动】' },
      { mergedContent: '国移动】您的账户余额为199.88元' },
    );

    expect(checkState('bal-merged')).toMatchObject({
      status: 'parsed',
      raw_response: '国移动】您的账户余额为199.88元',
    });
  });

  test('creates a runtime skill job when fixed rules cannot resolve a menu', async () => {
    sqlite
      .query(`UPDATE sim_balance_profiles SET skill_config = ? WHERE id = ?`)
      .run(AI_SKILL, MOBILE_PROFILE);
    const check = await pendingCheck({ id: 'bal-runtime-skill' });
    insertMessage({
      id: 'msg-unfamiliar-menu',
      type: 'received',
      content: '11.账务查询\n12.客户服务',
      number: '10086',
    });

    await linkBalanceReply(db, check, {
      id: 'msg-unfamiliar-menu',
      phone_number: '10086',
      content: '11.账务查询\n12.客户服务',
    });

    expect(checkState('bal-runtime-skill').status).toBe('response_received');
    expect(
      every(
        v.object({
          check_id: v.string(),
          response_message_id: v.nullable(v.string()),
          step_index: v.number(),
          status: v.string(),
        }),
        `SELECT check_id, response_message_id, step_index, status FROM sim_balance_skill_jobs`,
      ),
    ).toEqual([
      {
        check_id: 'bal-runtime-skill',
        response_message_id: 'msg-unfamiliar-menu',
        step_index: 0,
        status: 'pending',
      },
    ]);
  });

  test('creates no skill job once the skill has used its turns', async () => {
    sqlite
      .query(`UPDATE sim_balance_profiles SET skill_config = ? WHERE id = ?`)
      .run(AI_SKILL, MOBILE_PROFILE);
    const check = await pendingCheck({ id: 'bal-exhausted', step: 4 });
    insertMessage({ id: 'msg', type: 'received', content: '11.账务查询', number: '10086' });

    await linkBalanceReply(db, check, { id: 'msg', phone_number: '10086', content: '11.账务查询' });

    expect(count(`SELECT COUNT(*) AS count FROM sim_balance_skill_jobs`)).toBe(0);
  });

  test('does not overwrite a check that already moved on', async () => {
    const check = await pendingCheck({ id: 'bal-1', step: 2 });
    sqlite.run(`UPDATE sim_balance_checks SET status = 'parsed' WHERE id = 'bal-1'`);

    const result = await linkBalanceReply(db, check, {
      id: 'late',
      phone_number: '10086',
      content: '您的账户余额为1.00元',
    });

    expect(result).toMatchObject({ linked: false });
    expect(checkState('bal-1').raw_response).toBeNull();
  });
});

describe('balance parsers', () => {
  test('parses China Telecom total balance (当前号码总余额) when present', () => {
    expect(
      parseBalanceMetrics(
        'cn-telecom-balance-v1',
        '【中国电信】尊敬的孙*客户：截止至8月18日，您的手机账户当前可用余额为86.36元，当前号码总余额为263.36元，预存费用余额为263.36元，赠送费用余额为0.00元。感谢您的使用！',
      ),
    ).toEqual([
      { metric_type: 'cash_balance', value: 263.36, unit: null, currency: 'CNY', expires_at: null },
    ]);
  });

  test('falls back to 当前可用余额 when 总余额 is absent', () => {
    expect(
      parseBalanceMetrics(
        'cn-telecom-balance-v1',
        '【中国电信】您的手机账户当前可用余额为86.36元。',
      )[0]?.value,
    ).toBe(86.36);
  });

  test('parses China Telecom general balance (当前号码通用余额) without treating charges as balance', () => {
    expect(
      parseBalanceMetrics(
        'cn-telecom-balance-v1',
        '当前号码通用余额为140.76元，本月已产生费用149.00元。',
      )[0]?.value,
    ).toBe(140.76);
  });

  test('parses China Telecom SMS with only 总余额 and no 可用余额', () => {
    expect(
      parseBalanceMetrics(
        'cn-telecom-balance-v1',
        '当前号码总余额为263.36元，预存费用余额为263.36元。',
      )[0]?.value,
    ).toBe(263.36);
  });

  test('does not parse current charges as cash balance', () => {
    expect(
      parseBalanceMetrics('cn-mobile-balance-v1', '本月已产生话费25.60元，当前欠费0元。'),
    ).toEqual([]);
  });

  test('parses nothing for an unknown parser', () => {
    expect(parseBalanceMetrics('unknown-v1', '余额为1.00元')).toEqual([]);
  });
});

describe('balance timeout maintenance', () => {
  test('expires stale unanswered checks and stops their skill jobs', async () => {
    insertSim({ iccid: ICCID, index: 1 });
    insertSim({ iccid: 'sim-2', index: 2 });
    insertSim({ iccid: 'sim-3', index: 3 });
    insertCheck({ id: 'check-failed', status: 'failed', requestedAt: '2026-08-24 07:48:54' });
    sqlite
      .query(
        `UPDATE sim_balance_checks SET error = 'SMS submission was not confirmed' WHERE id = ?`,
      )
      .run('check-failed');
    insertCheck({
      id: 'check-stale',
      status: 'awaiting_response',
      sim: 'sim-2',
      sentAt: now('-40 minutes'),
      deadlineAt: now('-10 minutes'),
    });
    insertCheck({
      id: 'check-fresh',
      status: 'awaiting_response',
      sim: 'sim-3',
      sentAt: now('-5 minutes'),
      deadlineAt: now('+25 minutes'),
    });
    insertMessage({ id: 'reply', type: 'received', content: '歡迎使用短信營業廳', sim: 'sim-2' });
    sqlite.run(`
      INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index, status)
      VALUES ('job-stale', 'check-stale', 'reply', 0, 'leased'),
             ('job-fresh', 'check-fresh', NULL, 0, 'pending');
    `);

    expect(await expireStaleBalanceChecks(db)).toEqual({ expired: 1, stopped_jobs: 1 });

    expect(checkState('check-failed')).toMatchObject({
      status: 'failed',
      error: 'SMS submission was not confirmed',
    });
    expect(checkState('check-stale')).toMatchObject({
      status: 'timed_out',
      error: 'No reply received within the configured response window',
    });
    expect(checkState('check-fresh').status).toBe('awaiting_response');
    expect(
      every(
        v.object({ id: v.string(), status: v.string(), last_error: v.nullable(v.string()) }),
        `SELECT id, status, last_error FROM sim_balance_skill_jobs ORDER BY id`,
      ),
    ).toEqual([
      { id: 'job-fresh', status: 'pending', last_error: null },
      { id: 'job-stale', status: 'stopped', last_error: 'Balance response window expired' },
    ]);
  });
});

const ContinuedBody = v.object({
  success: v.literal(true),
  check: v.object({
    id: v.string(),
    status: v.literal('queued'),
    step_index: v.number(),
    outbound_message_id: v.nullable(v.string()),
  }),
});

describe('POST /api/control/balance-checks/continue', () => {
  beforeEach(() => {
    insertSim({ iccid: ICCID, index: 1, number: NUMBER });
    sqlite
      .query(`UPDATE sim_balance_profiles SET conversation_steps = ? WHERE id = ?`)
      .run(MENU_STEPS, MOBILE_PROFILE);
    insertMessage({ id: 'msg-menu', type: 'received', content: '1.话费与AI豆', number: '10086' });
  });

  test('continues an existing menu-stage check without creating a new check', async () => {
    insertCheck({
      id: 'bal-existing',
      status: 'response_received',
      responseMessageId: 'msg-menu',
      responseSender: '10086',
      rawResponse: '1.话费与AI豆',
    });

    const response = await balanceQueriesHandler.continue(
      controlRequest({ check_id: 'bal-existing' }),
    );
    const { check } = await read(response, ContinuedBody);

    const sent = every(OutboundRow, `SELECT ${OUTBOUND_COLUMNS} FROM messages WHERE type = 'sent'`);
    expect(response.status).toBe(202);
    expect(check).toEqual({
      id: 'bal-existing',
      status: 'queued',
      step_index: 1,
      outbound_message_id: sent[0]?.id ?? null,
    });
    expect(count(`SELECT COUNT(*) AS count FROM sim_balance_checks`)).toBe(1);
    expect(sent).toMatchObject([
      { content: '1', recipient: '10086', phone_number: NUMBER, balance_check_id: 'bal-existing' },
    ]);
  });

  test('rejects a check with no recorded reply', async () => {
    insertSim({ iccid: 'sim-2', index: 2 });
    insertCheck({ id: 'no-message', status: 'unparsed', rawResponse: '1.话费与AI豆' });
    insertCheck({ id: 'no-text', status: 'unparsed', sim: 'sim-2', responseMessageId: 'msg-menu' });
    sqlite
      .query(`UPDATE sim_balance_profiles SET conversation_steps = ? WHERE id = ?`)
      .run('[{"response_contains":"","command":"1"}]', MOBILE_PROFILE);

    for (const id of ['no-message', 'no-text']) {
      const response = await balanceQueriesHandler.continue(controlRequest({ check_id: id }));
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('Balance check cannot be continued');
    }
    expect(count(`SELECT COUNT(*) AS count FROM messages WHERE type = 'sent'`)).toBe(0);
  });

  test('rejects a reply that has no configured next step, or a check in another state', async () => {
    insertCheck({
      id: 'bal-other',
      status: 'response_received',
      responseMessageId: 'msg-menu',
      rawResponse: '欢迎使用中国移动',
    });
    insertSim({ iccid: 'sim-2', index: 2 });
    insertCheck({ id: 'bal-waiting', status: 'awaiting_response', sim: 'sim-2' });

    const other = await balanceQueriesHandler.continue(controlRequest({ check_id: 'bal-other' }));
    expect(other.status).toBe(409);
    expect(await errorOf(other)).toBe('No allowlisted next step matches the reply');

    const waiting = await balanceQueriesHandler.continue(
      controlRequest({ check_id: 'bal-waiting' }),
    );
    expect(waiting.status).toBe(409);
    expect(await errorOf(waiting)).toBe('Balance check cannot be continued');

    const missing = await balanceQueriesHandler.continue(controlRequest({ check_id: 'nope' }));
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toBe('Balance check not found');
  });

  test('requires the API key and a check_id', async () => {
    const unauthorized = await balanceQueriesHandler.continue(
      controlRequest({ check_id: 'x' }, { apiKey: 'wrong', database: untouchable }),
    );
    expect(unauthorized.status).toBe(401);

    for (const body of [{}, { check_id: 1 }, []]) {
      const response = await balanceQueriesHandler.continue(
        controlRequest(body, { database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('check_id is required');
    }
  });
});

describe('POST /api/control/balance-checks/retry', () => {
  beforeEach(() => {
    insertSim({ iccid: ICCID, index: 1, number: NUMBER });
    sqlite
      .query(`UPDATE sim_balance_profiles SET conversation_steps = ? WHERE id = ?`)
      .run(MENU_STEPS, MOBILE_PROFILE);
  });

  function failedStep(content: string): void {
    insertCheck({ id: 'bal-failed', status: 'failed', step: 1 });
    insertMessage({
      id: 'msg-start',
      type: 'sent',
      content: '10086',
      recipient: '10086',
      status: 'sent',
      timestamp: '2026-09-01 10:00:00',
      checkId: 'bal-failed',
    });
    insertMessage({
      id: 'msg-option-1',
      type: 'sent',
      content,
      recipient: '10086',
      status: 'failed',
      timestamp: '2026-09-01 10:01:00',
      checkId: 'bal-failed',
    });
    sqlite.run(
      `UPDATE messages SET error_message = 'modem error', processing_session_id = 's1' WHERE id = 'msg-option-1'`,
    );
  }

  test('requeues only the last failed allowlisted maintenance step', async () => {
    failedStep('1');

    const response = await balanceQueriesHandler.retry(controlRequest({ check_id: 'bal-failed' }));
    const { check } = await read(response, ContinuedBody);

    expect(response.status).toBe(202);
    expect(check).toEqual({
      id: 'bal-failed',
      status: 'queued',
      step_index: 1,
      outbound_message_id: 'msg-option-1',
    });
    expect(
      one(
        Row,
        `SELECT status, error_message, processing_session_id FROM messages WHERE id = 'msg-option-1'`,
      ),
    ).toEqual({ status: 'sending', error_message: null, processing_session_id: null });
    expect(checkState('bal-failed')).toMatchObject({
      status: 'queued',
      error: null,
      completed_at: null,
    });
  });

  test('rejects a failed message whose content differs from the configured step', async () => {
    failedStep('2');

    const response = await balanceQueriesHandler.retry(controlRequest({ check_id: 'bal-failed' }));

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('No allowlisted failed step can be retried');
    expect(checkState('bal-failed').status).toBe('failed');
  });

  test('rejects a check that has no failed step', async () => {
    insertCheck({ id: 'bal-start', status: 'failed' });
    insertMessage({
      id: 'msg-start',
      type: 'sent',
      content: '10086',
      recipient: '10086',
      status: 'failed',
      checkId: 'bal-start',
    });

    for (const id of ['bal-start', 'nope']) {
      const response = await balanceQueriesHandler.retry(controlRequest({ check_id: id }));
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('No allowlisted failed step can be retried');
    }
  });
});

describe('POST /api/control/balance-checks/stop', () => {
  beforeEach(() => {
    insertSim({ iccid: ICCID, index: 1 });
  });

  test('terminalizes an awaiting reply as timed out', async () => {
    insertCheck({ id: 'bal-waiting', status: 'awaiting_response' });

    const response = await balanceQueriesHandler.stop(controlRequest({ check_id: 'bal-waiting' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      check: { id: 'bal-waiting', status: 'timed_out' },
    });
    expect(checkState('bal-waiting')).toMatchObject({
      status: 'timed_out',
      error: 'Stopped by operator',
    });
  });

  test('terminalizes an unresolved received reply as unparsed and stops its skill job', async () => {
    insertCheck({ id: 'bal-unresolved', status: 'response_received', responseMessageId: 'reply' });
    insertMessage({ id: 'reply', type: 'received', content: 'menu' });
    sqlite.run(`
      UPDATE sim_balance_checks SET error = 'kept' WHERE id = 'bal-unresolved';
      INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index, status)
      VALUES ('job', 'bal-unresolved', 'reply', 0, 'leased');
    `);

    const response = await balanceQueriesHandler.stop(
      controlRequest({ check_id: 'bal-unresolved' }),
    );

    expect(await response.json()).toEqual({
      success: true,
      check: { id: 'bal-unresolved', status: 'unparsed' },
    });
    expect(checkState('bal-unresolved')).toMatchObject({ status: 'unparsed', error: 'kept' });
    expect(
      one(
        Row,
        `SELECT status, lease_owner, last_error FROM sim_balance_skill_jobs WHERE id = 'job'`,
      ),
    ).toEqual({ status: 'stopped', lease_owner: null, last_error: 'Stopped by operator' });
  });

  test('refuses a check that is not stoppable', async () => {
    insertCheck({ id: 'bal-parsed', status: 'parsed' });

    const parsed = await balanceQueriesHandler.stop(controlRequest({ check_id: 'bal-parsed' }));
    expect(parsed.status).toBe(409);
    expect(await errorOf(parsed)).toBe('Balance check is not stoppable');

    const missing = await balanceQueriesHandler.stop(controlRequest({ check_id: 'nope' }));
    expect(missing.status).toBe(404);
  });
});

describe('row schemas', () => {
  test('a row that drifts from its schema fails the request instead of leaking', async () => {
    enableDirectMobileProfile();
    insertSim({ iccid: ICCID, index: 1 });
    sqlite.run(`UPDATE sims SET sim_index = 'S01' WHERE iccid = '${ICCID}'`);

    const failure = await balanceQueriesHandler.preview(dashboardRequest()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(v.ValiError);
  });
});

describe('multipart carrier replies', () => {
  // Real S62 reply, split by the carrier into three parts that share a sender and
  // arrival timestamp. The balance sits in the third part.
  const parts = [
    {
      id: 'part-1',
      phone_iccid: '898600310123F0100634',
      phone_number: '10086',
      timestamp: '2026-09-29T05:35:41.000Z',
      content: '国移动】',
    },
    {
      id: 'part-2',
      phone_iccid: '898600310123F0100634',
      phone_number: '10086',
      timestamp: '2026-09-29T05:35:41.000Z',
      content: '有账单消费；\n欢迎您前往中国移动 APP 随时随地查余额。',
    },
    {
      id: 'part-3',
      phone_iccid: '898600310123F0100634',
      phone_number: '10086',
      timestamp: '2026-09-29T05:35:41.000Z',
      content: '【余额查询】尊敬的客户，您的151****1418账户余额为199.88元，详细如下。',
    },
  ];

  test('groups parts that share sender and timestamp', () => {
    const merged = mergeMultipartReplies(parts);
    expect(merged.size).toBe(3);
    // Every part of one reply resolves to the same group and the same merged text.
    const group = merged.get('part-1');
    for (const part of parts) {
      expect(merged.get(part.id)).toEqual(group);
    }
    expect(group?.content).toContain('199.88');
  });

  test('leaves a single-part reply ungrouped', () => {
    expect(mergeMultipartReplies(parts.slice(0, 1)).size).toBe(0);
  });

  test('keeps separately delivered replies apart', () => {
    const merged = mergeMultipartReplies([
      ...parts.slice(0, 1),
      { ...parts[1], id: 'other', timestamp: '2026-09-29T05:36:41.000Z' },
    ]);
    expect(merged.size).toBe(0);
  });

  test('keeps different senders apart', () => {
    const merged = mergeMultipartReplies([
      ...parts.slice(0, 1),
      { ...parts[1], id: 'other', phone_number: '10010' },
    ]);
    expect(merged.size).toBe(0);
  });

  test('ignores a part without an id or content', () => {
    const merged = mergeMultipartReplies([
      ...parts.slice(0, 1),
      { ...parts[1], id: '' },
      { ...parts[2], content: '' },
    ]);
    expect(merged.size).toBe(0);
  });

  test('the balance survives whichever part is processed first', () => {
    const merged = mergeMultipartReplies(parts);
    const full = merged.get('part-1')?.content ?? '';

    // The fragment carrying the balance is parseable, but the fragment processed
    // first is not — which is what closed S62 as unparsed before its balance part
    // was ever examined.
    expect(parseBalanceMetrics('cn-mobile-balance-v1', parts[0]?.content ?? '')).toEqual([]);
    expect(parseBalanceMetrics('cn-mobile-balance-v1', parts[2]?.content ?? '')).toHaveLength(1);

    // Merging makes the outcome independent of which part arrives first.
    expect(merged.get('part-3')?.content).toBe(full);
    const metrics = parseBalanceMetrics('cn-mobile-balance-v1', full);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      metric_type: 'cash_balance',
      value: 199.88,
      currency: 'CNY',
    });
  });
});
