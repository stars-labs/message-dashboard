import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { Schema } from '../../shared/parse-json.js';
import { createWebBalanceSchema } from '../../test/web-balance-schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { auth0Handler } from './auth0.js';
import {
  carrierWebBalanceHandler,
  createCarrierWebBalanceStatements,
  maintainWebBalanceJobs,
  newCarrierWebBalanceIds,
  reconcileTerminalWebBalanceJobs,
} from './carrier-web-balance.js';

const API_KEY = 'secret';
const BROWSER_SCOPE = 'balance:browser:run';
const SIM_NUMBER = '+8617600419127';
const M1_NUMBER = '+6590950236';

type TestDb = D1 & D1Batch;

interface RequestOptions {
  id?: string;
  runnerId?: string | null;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  database?: TestDb;
}

const Claimed = v.object({
  id: v.string(),
  check_id: v.string(),
  sim_iccid: v.string(),
  sim_number: v.nullable(v.string()),
  sim_index: v.nullable(v.number()),
  login_url: v.string(),
  otp_requested_at: v.nullable(v.string()),
  skill: v.looseObject({ id: v.string() }),
});
const Fields = v.record(v.string(), v.unknown());
const ErrorBody = v.object({ error: v.string() });
const JobState = v.object({
  status: v.string(),
  lease_owner: v.nullable(v.string()),
  lease_expires_at: v.nullable(v.string()),
  attempts: v.number(),
  last_error: v.nullable(v.string()),
  human_reason: v.nullable(v.string()),
  otp_requested_at: v.nullable(v.string()),
  otp_message_id: v.nullable(v.string()),
});
const CheckState = v.object({
  status: v.string(),
  error: v.nullable(v.string()),
  completed_at: v.nullable(v.string()),
  raw_response: v.nullable(v.string()),
});
const EventRow = v.object({ event_type: v.string(), detail_json: v.string() });
const MetricRow = v.object({
  metric_type: v.string(),
  value: v.nullable(v.number()),
  currency: v.nullable(v.string()),
  expires_at: v.nullable(v.string()),
});
const CountRow = v.object({ count: v.number() });

let sqlite: Database;
let db: TestDb;
let verifySpy: Mock<typeof auth0Handler.verifyToken>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createWebBalanceSchema(sqlite);
  sqlite.run(`
    INSERT INTO sims (iccid, sim_index, phone_number) VALUES ('iccid-1', 1, '${SIM_NUMBER}');
    INSERT INTO sim_balance_checks (
      id, sim_iccid, profile_id, status, parser_version
    ) VALUES (
      'check-1', 'iccid-1', 'cn-unicom-browser-random-password-v1',
      'queued', 'cn-unicom-web-balance-v1'
    );
    INSERT INTO sim_balance_web_jobs (id, check_id, provider)
    VALUES ('job-1', 'check-1', 'china_unicom');
  `);
  db = sqliteD1(sqlite);
  verifySpy = spyOn(auth0Handler, 'verifyToken').mockRejectedValue(new Error('no device token'));
});

afterEach(() => {
  verifySpy.mockRestore();
  sqlite.close();
});

function makeRequest({
  id,
  runnerId = 'runner-1',
  query = {},
  body,
  rawBody,
  headers = { 'X-API-Key': API_KEY },
  database = db,
}: RequestOptions = {}) {
  const params = new URLSearchParams(query);
  if (runnerId !== null) params.set('runner_id', runnerId);
  const text = rawBody ?? JSON.stringify(body ?? null);
  return {
    env: { API_KEY, AUTH0_DOMAIN: 'tenant.example', DB: database },
    headers: new Headers(headers),
    url: `https://example.com/api/control/carrier-web-balance/jobs/claim?${params.toString()}`,
    params: id === undefined ? {} : { id },
    text: () => Promise.resolve(text),
  };
}

function signInDevice(subject: string, scope: string = BROWSER_SCOPE): Record<string, string> {
  verifySpy.mockResolvedValue({ sub: subject, scope });
  return { Authorization: 'Bearer device-jwt' };
}

function recording(database: TestDb): TestDb & { prepared: string[] } {
  const prepared: string[] = [];
  return {
    prepared,
    prepare: (sql) => {
      prepared.push(sql);
      return database.prepare(sql);
    },
    batch: (statements) => database.batch(statements),
  };
}

function one<T>(schema: Schema<T>, sql: string): T {
  return v.parse(schema, sqlite.query(sql).get());
}

function every<T>(schema: Schema<T>, sql: string): T[] {
  return v.parse(v.array(schema), sqlite.query(sql).all());
}

function jobState() {
  return one(
    JobState,
    `SELECT status, lease_owner, lease_expires_at, attempts, last_error, human_reason,
            otp_requested_at, otp_message_id
     FROM sim_balance_web_jobs WHERE id = 'job-1'`,
  );
}

function checkState() {
  return one(
    CheckState,
    "SELECT status, error, completed_at, raw_response FROM sim_balance_checks WHERE id = 'check-1'",
  );
}

function events() {
  return every(
    EventRow,
    "SELECT event_type, detail_json FROM sim_balance_web_events WHERE job_id = 'job-1' ORDER BY id",
  );
}

function metrics() {
  return every(
    MetricRow,
    `SELECT metric_type, value, currency, expires_at
     FROM sim_balance_metrics WHERE check_id = 'check-1' ORDER BY metric_type`,
  );
}

function count(sql: string): number {
  return one(CountRow, sql).count;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function errorOf(response: Response): Promise<string> {
  return v.parse(ErrorBody, await response.json()).error;
}

async function claim() {
  const response = await carrierWebBalanceHandler.claim(makeRequest());
  expect(response.status).toBe(200);
  return v.parse(Claimed, await response.json());
}

function leaseTo(runnerId: string, status = 'leased', modifier = '+120 seconds') {
  sqlite.run(
    `UPDATE sim_balance_web_jobs
     SET status = ?, lease_owner = ?, lease_expires_at = datetime('now', ?)
     WHERE id = 'job-1'`,
    [status, runnerId, modifier],
  );
}

function switchToM1() {
  sqlite.run(`
    UPDATE sims SET phone_number = '${M1_NUMBER}' WHERE iccid = 'iccid-1';
    UPDATE sim_balance_checks
    SET profile_id = 'sg-m1-prepaid-browser-v1',
        parser_version = 'sg-m1-prepaid-web-balance-v1'
    WHERE id = 'check-1';
    UPDATE sim_balance_web_jobs SET provider = 'm1_prepaid' WHERE id = 'job-1';
  `);
}

async function requestOtp(jobId: string) {
  const response = await carrierWebBalanceHandler.otpRequested(
    makeRequest({ id: jobId, body: { runner_id: 'runner-1' } }),
  );
  expect(response.status).toBe(200);
}

function insertMessage(
  id: string,
  sender: string,
  content: string,
  code: string,
  createdAt = 'CURRENT_TIMESTAMP',
  iccid = 'iccid-1',
) {
  sqlite.run(
    `INSERT INTO messages (
       id, phone_iccid, phone_number, content, type, verification_code, created_at
     ) VALUES (?, ?, ?, ?, 'received', ?, ${createdAt})`,
    [id, iccid, sender, content, code],
  );
}

type BodyHandlerName = 'otpRequested' | 'heartbeat' | 'complete' | 'fail' | 'release';

const BODY_HANDLERS: BodyHandlerName[] = [
  'otpRequested',
  'heartbeat',
  'complete',
  'fail',
  'release',
];

const VALID_BODIES: Record<BodyHandlerName, Record<string, unknown>> = {
  otpRequested: { runner_id: 'runner-1' },
  heartbeat: { runner_id: 'runner-1', status: 'querying' },
  complete: {
    runner_id: 'runner-1',
    balance: 18.25,
    currency: 'CNY',
    account_number: SIM_NUMBER,
  },
  fail: { runner_id: 'runner-1' },
  release: { runner_id: 'runner-1' },
};

function callBodyHandler(name: BodyHandlerName, options: RequestOptions) {
  return carrierWebBalanceHandler[name](makeRequest(options));
}

describe('carrier browser balance job protocol', () => {
  test('leases a browser job without exposing carrier credentials', async () => {
    const job = await claim();
    expect(job.sim_number).toBe(SIM_NUMBER);
    expect(job.login_url).toContain('10010.com');
    expect(job.otp_requested_at).toBeNull();
    expect(JSON.stringify(job)).not.toContain('cookie');
    expect(jobState().status).toBe('leased');
  });

  test('describes the claimed job and records the claim', async () => {
    const job = await claim();

    expect(job).toMatchObject({
      id: 'job-1',
      check_id: 'check-1',
      sim_iccid: 'iccid-1',
      sim_index: 1,
      skill: { id: 'unicom-web-balance', login_mode: 'random_password' },
    });
    expect(jobState()).toMatchObject({ lease_owner: 'runner-1', attempts: 1 });
    expect(events()).toEqual([{ event_type: 'claimed', detail_json: '{"attempts":1}' }]);
  });

  test('forces the pending-job index on the claim hot path', async () => {
    const recorded = recording(db);

    await carrierWebBalanceHandler.claim(makeRequest({ database: recorded }));

    expect(recorded.prepared[0]).toContain(
      'sim_balance_web_jobs j INDEXED BY idx_balance_web_jobs_pending_claim',
    );
  });

  test('does not let a legacy runner claim a Dashboard-owned browser job', async () => {
    sqlite.run("UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'");

    const response = await carrierWebBalanceHandler.claim(makeRequest());
    expect(response.status).toBe(204);
    expect(jobState().status).toBe('pending');
  });

  test('keeps the five-second claim path free of maintenance work', async () => {
    sqlite.run("UPDATE sim_balance_web_jobs SET status = 'stopped' WHERE id = 'job-1'");

    const response = await carrierWebBalanceHandler.claim(makeRequest());

    expect(response.status).toBe(204);
    expect(checkState().status).toBe('queued');
  });

  test('returns only an OTP from the same SIM, allowlisted sender and request window', async () => {
    const job = await claim();
    await requestOtp(job.id);
    insertMessage('wrong-context', '10010', '优惠码123456', '123456');
    insertMessage('right', '+8610010', '您的随机密码为654321，请勿泄露', '654321');
    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: job.id }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: '654321' });
  });

  test('advances an OTP cursor with the daemon source message id', async () => {
    const job = await claim();
    await requestOtp(job.id);
    insertMessage('source-message-1', '10010', '优惠码123456', '123456', "'2026-09-04 10:00:00'");
    insertMessage('source-message-2', '10010', '优惠码234567', '234567', "'2026-09-04 10:00:00'");
    sqlite.run("UPDATE sim_balance_web_jobs SET otp_requested_at = '2026-09-04 09:59:00'");

    const first = await carrierWebBalanceHandler.otp(makeRequest({ id: job.id }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      code: null,
      cursor: {
        created_at: '2026-09-04 10:00:00',
        source_message_id: 'source-message-2',
      },
    });

    insertMessage(
      'source-message-3',
      '+8610010',
      '您的随机密码为654321，请勿泄露',
      '654321',
      "'2026-09-04 10:00:01'",
    );
    const second = await carrierWebBalanceHandler.otp(
      makeRequest({
        id: job.id,
        query: {
          after_created_at: '2026-09-04 10:00:00',
          after_source_message_id: 'source-message-2',
        },
      }),
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ code: '654321' });
  });

  test('ignores a cursor that is only half given or too long', async () => {
    const job = await claim();
    await requestOtp(job.id);
    sqlite.run("UPDATE sim_balance_web_jobs SET otp_requested_at = '2026-09-04 09:59:00'");
    insertMessage(
      'early',
      '+8610010',
      '您的随机密码为654321，请勿泄露',
      '654321',
      "'2026-09-04 10:00:00'",
    );

    for (const query of [
      { after_created_at: '2026-09-04 10:00:00' },
      { after_source_message_id: 'early' },
      { after_created_at: 'x'.repeat(41), after_source_message_id: 'early' },
      { after_created_at: '2026-09-04 10:00:00', after_source_message_id: 'x'.repeat(201) },
    ]) {
      const response = await carrierWebBalanceHandler.otp(makeRequest({ id: job.id, query }));
      expect(await response.json()).toEqual({ code: '654321' });
    }
  });

  test('records the matched OTP message on the job', async () => {
    const job = await claim();
    await requestOtp(job.id);
    insertMessage('right', '+8610010', '您的随机密码为654321，请勿泄露', '654321');

    await carrierWebBalanceHandler.otp(makeRequest({ id: job.id }));

    expect(jobState().otp_message_id).toBe('right');
    expect(events().at(-1)).toEqual({
      event_type: 'otp_matched',
      detail_json: '{"message_id":"right"}',
    });
  });

  test('ignores an OTP received by another SIM', async () => {
    const job = await claim();
    await requestOtp(job.id);
    insertMessage(
      'other-sim',
      '+8610010',
      '您的随机密码为654321，请勿泄露',
      '654321',
      undefined,
      'iccid-2',
    );

    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: job.id }));

    expect(response.status).toBe(204);
  });

  test('answers 204 when no OTP has arrived', async () => {
    const job = await claim();
    await requestOtp(job.id);

    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: job.id }));

    expect(response.status).toBe(204);
  });

  test('refuses an OTP poll before an OTP was requested', async () => {
    const job = await claim();

    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: job.id }));

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('OTP has not been requested');
  });

  test('refuses a second OTP request for the same job', async () => {
    const job = await claim();
    await requestOtp(job.id);

    const response = await carrierWebBalanceHandler.otpRequested(
      makeRequest({ id: job.id, body: { runner_id: 'runner-1' } }),
    );

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('OTP was already requested for this job');
    expect(events().filter((event) => event.event_type === 'otp_requested')).toHaveLength(1);
  });

  test('moves the job to awaiting_otp when the OTP is requested', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.otpRequested(
      makeRequest({ id: job.id, body: { runner_id: 'runner-1' } }),
    );

    expect(await response.json()).toEqual({ success: true, status: 'awaiting_otp' });
    expect(jobState().status).toBe('awaiting_otp');
    expect(jobState().otp_requested_at).not.toBeNull();
  });

  test('extends the lease while waiting for human verification', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          status: 'human_verification_required',
          reason: '请完成滑块验证',
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ lease_seconds: 900 });
    expect(jobState()).toMatchObject({
      status: 'human_verification_required',
      human_reason: '请完成滑块验证',
    });
  });

  test('renews a lease without appending duplicate heartbeat events', async () => {
    const job = await claim();
    const heartbeatRequest = () =>
      makeRequest({ id: job.id, body: { runner_id: 'runner-1', status: 'awaiting_otp' } });

    await carrierWebBalanceHandler.heartbeat(heartbeatRequest());
    await carrierWebBalanceHandler.heartbeat(heartbeatRequest());

    expect(events().filter((event) => event.event_type === 'awaiting_otp')).toHaveLength(1);
  });

  test('keeps the normal lease and no reason for an ordinary heartbeat', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({
        id: job.id,
        body: { runner_id: 'runner-1', status: 'querying', reason: 'ignored' },
      }),
    );

    expect(await response.json()).toEqual({
      success: true,
      status: 'querying',
      lease_seconds: 120,
    });
    expect(jobState()).toMatchObject({ status: 'querying', human_reason: null });
    expect(events().at(-1)).toEqual({
      event_type: 'querying',
      detail_json: '{"status":"querying"}',
    });
  });

  test('matches only the M1 login OTP for an M1 prepaid job', async () => {
    switchToM1();
    const job = await claim();
    await requestOtp(job.id);
    insertMessage('wrong-sender', '10010', 'OTP for login to selfcare portal is 111111', '111111');
    insertMessage('right-m1', 'M1 Limited', 'OTP for login to selfcare portal is 222222', '222222');

    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: job.id }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: '222222' });
  });

  test('stores a balance only for the task account', async () => {
    const job = await claim();
    const mismatch = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 18.25,
          currency: 'CNY',
          account_number: '+8618600000000',
        },
      }),
    );
    expect(mismatch.status).toBe(409);
    expect(await errorOf(mismatch)).toBe(
      'Authenticated account does not match the balance task SIM',
    );

    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 18.25,
          currency: 'CNY',
          account_number: SIM_NUMBER,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, status: 'parsed' });
    expect(checkState()).toMatchObject({
      status: 'parsed',
      raw_response: 'Official China Unicom web balance query',
    });
    expect(metrics()).toEqual([
      { metric_type: 'cash_balance', value: 18.25, currency: 'CNY', expires_at: null },
    ]);
    expect(jobState()).toMatchObject({
      status: 'completed',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(events().at(-1)).toEqual({
      event_type: 'completed',
      detail_json: '{"currency":"CNY","parser_version":"cn-unicom-web-balance-v1"}',
    });
  });

  test('accepts an account number written with the country code', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 1,
          currency: 'CNY',
          account_number: '17600419127',
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  test.each([-100001, 1000001])('refuses a balance of %d', async (balance) => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: { runner_id: 'runner-1', balance, currency: 'CNY', account_number: SIM_NUMBER },
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('balance is invalid');
  });

  test.each([-100000, 0, 1000000])('accepts a balance of %d', async (balance) => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: { runner_id: 'runner-1', balance, currency: 'CNY', account_number: SIM_NUMBER },
      }),
    );

    expect(response.status).toBe(200);
  });

  test.each([
    ['null', null],
    ['an empty string', ''],
    ['an empty list', []],
    ['a boolean', true],
    ['a numeric string', '18.25'],
    ['a missing value', undefined],
  ])('refuses a completion whose balance is %s', async (_case, balance) => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance,
          currency: 'CNY',
          account_number: SIM_NUMBER,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'balance is invalid' });
    expect(checkState().status).toBe('queued');
  });

  test('refuses a completion in the wrong currency', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: { runner_id: 'runner-1', balance: 1, currency: 'SGD', account_number: SIM_NUMBER },
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('currency must be CNY');
    expect(checkState().status).toBe('queued');
  });

  test.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 8617600419127],
    ['a list', [SIM_NUMBER]],
  ])('refuses a completion whose account number is %s', async (_case, accountNumber) => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 18.25,
          currency: 'CNY',
          account_number: accountNumber,
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(checkState().status).toBe('queued');
  });

  test('does not match a missing account number to a SIM without a number', async () => {
    sqlite.run("UPDATE sims SET phone_number = ''");
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: { runner_id: 'runner-1', balance: 18.25, currency: 'CNY' },
      }),
    );
    expect(response.status).toBe(409);
    expect(checkState().status).toBe('queued');
  });

  test('answers 409 when the check changed while the completion was written', async () => {
    const job = await claim();
    const racing: TestDb = {
      prepare: (sql) => db.prepare(sql),
      batch: (statements) => {
        sqlite.run("UPDATE sim_balance_checks SET status = 'failed' WHERE id = 'check-1'");
        return db.batch(statements);
      },
    };

    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        database: racing,
        body: {
          runner_id: 'runner-1',
          balance: 18.25,
          currency: 'CNY',
          account_number: SIM_NUMBER,
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Balance check changed before completion');
    expect(checkState().status).toBe('failed');
    expect(metrics()).toEqual([]);
  });

  test('stores both cash balance and account expiry for M1 prepaid', async () => {
    switchToM1();
    const job = await claim();

    const partial = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 9.97,
          currency: 'SGD',
          account_number: M1_NUMBER,
        },
      }),
    );
    expect(partial.status).toBe(400);
    expect(await errorOf(partial)).toBe('expires_at must be a real ISO calendar date');
    expect(
      count("SELECT COUNT(*) AS count FROM sim_balance_metrics WHERE check_id = 'check-1'"),
    ).toBe(0);

    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 9.97,
          currency: 'SGD',
          account_number: M1_NUMBER,
          expires_at: '2026-09-20',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(metrics()).toEqual([
      { metric_type: 'account_expiry', value: null, currency: null, expires_at: '2026-09-20' },
      { metric_type: 'cash_balance', value: 9.97, currency: 'SGD', expires_at: null },
    ]);
    expect(events().at(-1)).toEqual({
      event_type: 'completed',
      detail_json:
        '{"currency":"SGD","parser_version":"sg-m1-prepaid-web-balance-v1","expires_at":"2026-09-20"}',
    });
  });

  test('accepts an M1 account number written without the country code', async () => {
    switchToM1();
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 9.97,
          currency: 'SGD',
          account_number: '90950236',
          expires_at: '2026-09-20',
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  test.each(['2026-02-30', '2026-13-01', '20-09-2026', '2026-9-20', ''])(
    'refuses an M1 expiry of %p',
    async (expiresAt) => {
      switchToM1();
      const job = await claim();
      const response = await carrierWebBalanceHandler.complete(
        makeRequest({
          id: job.id,
          body: {
            runner_id: 'runner-1',
            balance: 9.97,
            currency: 'SGD',
            account_number: M1_NUMBER,
            expires_at: expiresAt,
          },
        }),
      );

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('expires_at must be a real ISO calendar date');
    },
  );

  test('refuses an M1 completion whose expiry is a list holding a date', async () => {
    switchToM1();
    const job = await claim();
    const response = await carrierWebBalanceHandler.complete(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          balance: 9.97,
          currency: 'SGD',
          account_number: M1_NUMBER,
          expires_at: ['2026-09-20'],
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'expires_at must be a real ISO calendar date',
    });
  });

  test('does not requeue a browser login after an OTP was requested', async () => {
    const job = await claim();
    await requestOtp(job.id);
    const response = await carrierWebBalanceHandler.release(
      makeRequest({ id: job.id, body: { runner_id: 'runner-1', error: 'Browser closed' } }),
    );
    expect(await response.json()).toEqual({ success: true, status: 'failed' });
    expect(jobState().status).toBe('failed');
    expect(checkState()).toMatchObject({ status: 'failed', error: 'Browser closed' });
    expect(events().at(-1)).toEqual({
      event_type: 'failed_after_otp',
      detail_json: '{"error":"Browser closed"}',
    });
  });

  test('requeues a browser job released before any OTP was requested', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.release(
      makeRequest({ id: job.id, body: { runner_id: 'runner-1', error: 'Browser closed' } }),
    );

    expect(await response.json()).toEqual({ success: true, status: 'pending' });
    expect(jobState()).toMatchObject({
      status: 'pending',
      lease_owner: null,
      last_error: 'Browser closed',
      attempts: 1,
    });
    expect(checkState().status).toBe('queued');
    expect(events().at(-1)?.event_type).toBe('released');
  });

  test('fails the job and its check', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.fail(
      makeRequest({ id: job.id, body: { runner_id: 'runner-1', error: 'Portal changed' } }),
    );

    expect(await response.json()).toEqual({ success: true, status: 'failed' });
    expect(jobState()).toMatchObject({
      status: 'failed',
      lease_owner: null,
      last_error: 'Portal changed',
    });
    expect(checkState()).toMatchObject({ status: 'failed', error: 'Portal changed' });
    expect(events().at(-1)).toEqual({
      event_type: 'failed',
      detail_json: '{"error":"Portal changed"}',
    });
  });

  test.each([
    ['fail', 'Web balance query failed'],
    ['release', 'Runner released the job'],
  ] as const)('gives a %s without an error a default one', async (action, expected) => {
    const job = await claim();
    await carrierWebBalanceHandler[action](
      makeRequest({ id: job.id, body: { runner_id: 'runner-1', error: '' } }),
    );

    expect(jobState().last_error).toBe(expected);
  });

  test.each(['fail', 'release'] as const)('truncates the error of a %s', async (action) => {
    const job = await claim();
    await carrierWebBalanceHandler[action](
      makeRequest({ id: job.id, body: { runner_id: 'runner-1', error: 'e'.repeat(1500) } }),
    );

    expect(jobState().last_error).toHaveLength(1000);
  });

  test('truncates a human verification reason', async () => {
    const job = await claim();
    await carrierWebBalanceHandler.heartbeat(
      makeRequest({
        id: job.id,
        body: {
          runner_id: 'runner-1',
          status: 'human_verification_required',
          reason: 'r'.repeat(600),
        },
      }),
    );

    expect(jobState().human_reason).toHaveLength(500);
  });

  test.each([
    ['a list holding a status', ['awaiting_otp'], 'Invalid web job status'],
    ['a number', 1, 'Invalid web job status'],
    ['an unknown status', 'completed', 'Invalid web job status'],
    ['missing', undefined, 'Invalid web job status'],
  ])('refuses a heartbeat whose status is %s', async (_case, status, message) => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({ id: job.id, body: { runner_id: 'runner-1', status } }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
  });

  test.each([
    ['an object', { text: 'x' }],
    ['a number', 5],
    ['a list', ['x']],
  ])('refuses a heartbeat whose reason is %s', async (_case, reason) => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({
        id: job.id,
        body: { runner_id: 'runner-1', status: 'human_verification_required', reason },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'reason must be text' });
    expect(jobState().status).toBe('leased');
  });

  test('falls back to the default reason when a heartbeat gives an empty one', async () => {
    const job = await claim();
    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({
        id: job.id,
        body: { runner_id: 'runner-1', status: 'human_verification_required', reason: '' },
      }),
    );
    expect(response.status).toBe(200);
    expect(jobState().human_reason).toBe('Official site requested human verification');
  });

  test.each(['fail', 'release'] as const)(
    'refuses a %s whose error is not text',
    async (action) => {
      const job = await claim();
      const response = await carrierWebBalanceHandler[action](
        makeRequest({ id: job.id, body: { runner_id: 'runner-1', error: { message: 'x' } } }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'error must be text' });
      expect(jobState().status).toBe('leased');
      expect(checkState().status).toBe('queued');
    },
  );
});

describe('claiming', () => {
  test.each([
    ['missing', null],
    ['blank', '   '],
    ['too long', 'r'.repeat(201)],
  ])('refuses a runner ID that is %s', async (_case, runnerId) => {
    const response = await carrierWebBalanceHandler.claim(makeRequest({ runnerId }));

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('runner_id is required');
    expect(jobState().status).toBe('pending');
  });

  test('trims the runner ID it leases the job to', async () => {
    const response = await carrierWebBalanceHandler.claim(makeRequest({ runnerId: ' runner-9 ' }));

    expect(response.status).toBe(200);
    expect(jobState().lease_owner).toBe('runner-9');
  });

  test('answers 204 when no job is pending', async () => {
    await claim();

    const response = await carrierWebBalanceHandler.claim(makeRequest({ runnerId: 'runner-2' }));

    expect(response.status).toBe(204);
  });

  test('stops leasing a job after three attempts', async () => {
    sqlite.run('UPDATE sim_balance_web_jobs SET attempts = 3');

    const response = await carrierWebBalanceHandler.claim(makeRequest());

    expect(response.status).toBe(204);
    expect(jobState().status).toBe('pending');
  });

  test('does not lease a job whose check is no longer queued', async () => {
    sqlite.run("UPDATE sim_balance_checks SET status = 'failed'");

    const response = await carrierWebBalanceHandler.claim(makeRequest());

    expect(response.status).toBe(204);
    expect(jobState().status).toBe('pending');
  });

  test.each([
    ['a different skill', '{"id":"m1-prepaid-web-balance"}'],
    ['no skill ID', '{}'],
    ['a non-text skill ID', '{"id":5}'],
    ['a list', '[]'],
    ['a number', '5'],
  ])('fails a job whose profile holds %s', async (_case, skillConfig) => {
    sqlite.run('UPDATE sim_balance_profiles SET skill_config = ? WHERE id = ?', [
      skillConfig,
      'cn-unicom-browser-random-password-v1',
    ]);

    const response = await carrierWebBalanceHandler.claim(makeRequest());

    expect(response.status).toBe(204);
    expect(jobState()).toMatchObject({
      status: 'failed',
      lease_owner: null,
      last_error: 'Invalid web skill configuration',
    });
    expect(checkState()).toMatchObject({
      status: 'failed',
      error: 'Invalid web skill configuration',
    });
  });

  test('refuses to read a SIM index that is not a number', async () => {
    sqlite.run("UPDATE sims SET sim_index = 'first'");

    const error = await failure(carrierWebBalanceHandler.claim(makeRequest()));

    expect(error).toBeInstanceOf(v.ValiError);
  });
});

describe('runner credentials', () => {
  test('refuses a claim without credentials', async () => {
    const response = await carrierWebBalanceHandler.claim(makeRequest({ headers: {} }));

    expect(response.status).toBe(401);
    expect(jobState().status).toBe('pending');
  });

  test('refuses a claim with a wrong API key', async () => {
    const response = await carrierWebBalanceHandler.claim(
      makeRequest({ headers: { 'X-API-Key': 'wrong' } }),
    );

    expect(response.status).toBe(401);
  });

  test('refuses a device token that lacks the browser scope', async () => {
    const response = await carrierWebBalanceHandler.claim(
      makeRequest({ headers: signInDevice('auth0|alice', 'balance:runners:heartbeat') }),
    );

    expect(response.status).toBe(401);
    expect(jobState().status).toBe('pending');
  });

  test.each(BODY_HANDLERS)('refuses %s without credentials', async (name) => {
    leaseTo('runner-1');

    const response = await callBodyHandler(name, {
      id: 'job-1',
      headers: {},
      body: VALID_BODIES[name],
    });

    expect(response.status).toBe(401);
    expect(jobState().status).toBe('leased');
  });

  test.each(BODY_HANDLERS)(
    'refuses %s with a device token that lacks the browser scope',
    async (name) => {
      leaseTo('runner-1');
      sqlite.run("UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'");

      const response = await callBodyHandler(name, {
        id: 'job-1',
        headers: signInDevice('auth0|alice', 'balance:runners:heartbeat'),
        body: VALID_BODIES[name],
      });

      expect(response.status).toBe(401);
      expect(jobState().status).toBe('leased');
    },
  );

  test('refuses an OTP poll with a device token that lacks the browser scope', async () => {
    leaseTo('runner-1');
    sqlite.run("UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'");

    const response = await carrierWebBalanceHandler.otp(
      makeRequest({
        id: 'job-1',
        headers: signInDevice('auth0|alice', 'balance:runners:heartbeat'),
      }),
    );

    expect(response.status).toBe(401);
  });

  test('refuses an OTP poll without credentials', async () => {
    leaseTo('runner-1');

    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: 'job-1', headers: {} }));

    expect(response.status).toBe(401);
  });

  test('lets a device runner claim a job its account requested', async () => {
    sqlite.run("UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'");

    const response = await carrierWebBalanceHandler.claim(
      makeRequest({ headers: signInDevice('auth0|alice') }),
    );

    expect(response.status).toBe(200);
    expect(jobState()).toMatchObject({ status: 'leased', lease_owner: 'runner-1' });
  });

  test("does not let a device runner claim another account's job", async () => {
    sqlite.run("UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'");

    const response = await carrierWebBalanceHandler.claim(
      makeRequest({ headers: signInDevice('auth0|mallory') }),
    );

    expect(response.status).toBe(204);
    expect(jobState().status).toBe('pending');
  });

  test('does not let a device runner claim a legacy control job', async () => {
    const response = await carrierWebBalanceHandler.claim(
      makeRequest({ headers: signInDevice('auth0|alice') }),
    );

    expect(response.status).toBe(204);
    expect(jobState().status).toBe('pending');
  });
});

describe('job ownership', () => {
  beforeEach(() => {
    leaseTo('runner-1');
  });

  function ownedBy(subject: string | null) {
    sqlite.run('UPDATE sim_balance_checks SET requested_by_subject = ?', [subject]);
  }

  test.each(BODY_HANDLERS)('%s refuses a legacy runner on a Dashboard-owned job', async (name) => {
    ownedBy('auth0|alice');

    const response = await callBodyHandler(name, { id: 'job-1', body: VALID_BODIES[name] });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toBe('Web balance job belongs to another account');
    expect(jobState().status).toBe('leased');
  });

  test.each(BODY_HANDLERS)("%s refuses another account's device runner", async (name) => {
    ownedBy('auth0|alice');

    const response = await callBodyHandler(name, {
      id: 'job-1',
      headers: signInDevice('auth0|mallory'),
      body: VALID_BODIES[name],
    });

    expect(response.status).toBe(403);
    expect(jobState().status).toBe('leased');
  });

  test.each(BODY_HANDLERS)('%s refuses a device runner on a legacy control job', async (name) => {
    const response = await callBodyHandler(name, {
      id: 'job-1',
      headers: signInDevice('auth0|alice'),
      body: VALID_BODIES[name],
    });

    expect(response.status).toBe(403);
    expect(jobState().status).toBe('leased');
  });

  test('otp refuses a legacy runner on a Dashboard-owned job', async () => {
    ownedBy('auth0|alice');

    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: 'job-1' }));

    expect(response.status).toBe(403);
  });

  test("otp refuses another account's device runner", async () => {
    ownedBy('auth0|alice');

    const response = await carrierWebBalanceHandler.otp(
      makeRequest({ id: 'job-1', headers: signInDevice('auth0|mallory') }),
    );

    expect(response.status).toBe(403);
  });

  test('lets the owning account heartbeat its job', async () => {
    ownedBy('auth0|alice');

    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({
        id: 'job-1',
        headers: signInDevice('auth0|alice'),
        body: { runner_id: 'runner-1', status: 'querying' },
      }),
    );

    expect(response.status).toBe(200);
    expect(jobState().status).toBe('querying');
  });
});

describe('job lease', () => {
  test.each(BODY_HANDLERS)('%s answers 404 for an unknown job', async (name) => {
    const response = await callBodyHandler(name, { id: 'missing', body: VALID_BODIES[name] });

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe('Web balance job not found');
  });

  test('otp answers 404 for an unknown job', async () => {
    const response = await carrierWebBalanceHandler.otp(makeRequest({ id: 'missing' }));

    expect(response.status).toBe(404);
  });

  test('answers 404 when the route carries no job ID', async () => {
    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({ body: VALID_BODIES.heartbeat }),
    );

    expect(response.status).toBe(404);
  });

  test.each(BODY_HANDLERS)("%s refuses another runner's lease", async (name) => {
    leaseTo('runner-2');

    const response = await callBodyHandler(name, { id: 'job-1', body: VALID_BODIES[name] });

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Web balance job lease is not active for this runner');
    expect(jobState().lease_owner).toBe('runner-2');
  });

  test.each(BODY_HANDLERS)('%s refuses an expired lease', async (name) => {
    leaseTo('runner-1', 'leased', '-1 minute');

    const response = await callBodyHandler(name, { id: 'job-1', body: VALID_BODIES[name] });

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Web balance job lease is not active for this runner');
  });

  test.each(['pending', 'completed', 'failed', 'stopped'])(
    'refuses a lease on a %s job',
    async (status) => {
      leaseTo('runner-1', status);

      const response = await carrierWebBalanceHandler.heartbeat(
        makeRequest({ id: 'job-1', body: VALID_BODIES.heartbeat }),
      );

      expect(response.status).toBe(409);
      expect(jobState().status).toBe(status);
    },
  );

  test('refuses a job that holds no lease expiry', async () => {
    leaseTo('runner-1');
    sqlite.run('UPDATE sim_balance_web_jobs SET lease_expires_at = NULL');

    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({ id: 'job-1', body: VALID_BODIES.heartbeat }),
    );

    expect(response.status).toBe(409);
  });

  test.each(BODY_HANDLERS)('%s refuses a job whose check is no longer queued', async (name) => {
    leaseTo('runner-1');
    sqlite.run("UPDATE sim_balance_checks SET status = 'timed_out'");

    const response = await callBodyHandler(name, { id: 'job-1', body: VALID_BODIES[name] });

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Balance check is no longer queued');
  });

  test('otp refuses another runner and a blank one', async () => {
    leaseTo('runner-1');
    sqlite.run('UPDATE sim_balance_web_jobs SET otp_requested_at = CURRENT_TIMESTAMP');

    for (const runnerId of ['runner-2', '']) {
      const response = await carrierWebBalanceHandler.otp(makeRequest({ id: 'job-1', runnerId }));
      expect(response.status).toBe(409);
    }
  });

  test('otp refuses a poll that names no runner', async () => {
    leaseTo('runner-1');

    const response = await carrierWebBalanceHandler.otp(
      makeRequest({ id: 'job-1', runnerId: null }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('runner_id is required');
  });
});

describe('runner ID in the request body', () => {
  beforeEach(() => {
    leaseTo('runner-1');
  });

  test.each(BODY_HANDLERS)('%s answers 400 to a body that is not JSON', async (name) => {
    const response = await callBodyHandler(name, { id: 'job-1', rawBody: '{not json' });

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('runner_id is required');
  });

  test.each([
    ['null', null],
    ['a list', []],
    ['a number', 5],
    ['an object without it', {}],
    ['a non-text runner ID', { runner_id: 7 }],
    ['a null runner ID', { runner_id: null }],
  ])('answers 400 to %s', async (_case, body) => {
    const response = await carrierWebBalanceHandler.heartbeat(makeRequest({ id: 'job-1', body }));

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('runner_id is required');
    expect(jobState().status).toBe('leased');
  });

  test('checks the runner ID before looking the job up', async () => {
    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({ id: 'missing', body: {} }),
    );

    expect(response.status).toBe(400);
  });

  test('checks the lease before the rest of the body', async () => {
    leaseTo('runner-2');

    const response = await carrierWebBalanceHandler.heartbeat(
      makeRequest({ id: 'job-1', body: { runner_id: 'runner-1', status: 'bogus' } }),
    );

    expect(response.status).toBe(409);
  });
});

describe('web job maintenance', () => {
  test('reconciles a terminal web job whose parent check is still queued', async () => {
    sqlite.run(`
      UPDATE sim_balance_web_jobs
      SET status = 'stopped', last_error = 'Runner stopped before completion',
          lease_owner = 'stale-runner', lease_expires_at = datetime('now', '-1 minute')
      WHERE id = 'job-1';
    `);

    const result = await reconcileTerminalWebBalanceJobs(db);

    expect(result.reconciled).toBe(1);
    expect(checkState()).toMatchObject({
      status: 'failed',
      error: 'Runner stopped before completion',
      raw_response: null,
    });
    expect(checkState().completed_at).not.toBeNull();
    expect(events().at(-1)).toEqual({
      event_type: 'reconciled',
      detail_json: '{"web_job_status":"stopped"}',
    });
    expect(jobState()).toMatchObject({ lease_owner: null, lease_expires_at: null });
  });

  test('gives a terminal job without an error message the default one', async () => {
    sqlite.run("UPDATE sim_balance_web_jobs SET status = 'failed', last_error = ''");

    await reconcileTerminalWebBalanceJobs(db);

    expect(checkState().error).toBe('Browser balance job ended before completion');
  });

  test('leaves a pending job and its check alone', async () => {
    const result = await reconcileTerminalWebBalanceJobs(db);

    expect(result).toEqual({ reconciled: 0 });
    expect(checkState().status).toBe('queued');
    expect(events()).toEqual([]);
  });

  test('fails a job whose lease expired and its check', async () => {
    leaseTo('runner-1', 'awaiting_otp', '-1 minute');

    const result = await maintainWebBalanceJobs(db);

    expect(result).toEqual({ expired: 1, reconciled: 0 });
    expect(jobState()).toMatchObject({
      status: 'failed',
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'Browser runner lease expired after login flow started',
    });
    expect(checkState()).toMatchObject({
      status: 'failed',
      error: 'Browser runner lease expired after login flow started',
    });
  });

  test('keeps a job whose lease is still running', async () => {
    leaseTo('runner-1', 'querying', '+5 minutes');

    const result = await maintainWebBalanceJobs(db);

    expect(result).toEqual({ expired: 0, reconciled: 0 });
    expect(jobState().status).toBe('querying');
    expect(checkState().status).toBe('queued');
  });

  test('reconciles terminal jobs after expiring leases', async () => {
    sqlite.run("UPDATE sim_balance_web_jobs SET status = 'stopped'");

    const result = await maintainWebBalanceJobs(db);

    expect(result).toEqual({ expired: 0, reconciled: 1 });
    expect(checkState().status).toBe('failed');
  });
});

describe('queueing a browser balance check', () => {
  const PROFILE = { id: 'cn-unicom-browser-random-password-v1', parser_version: 'parser-1' };
  const UNICOM_SKILL = '{"id":"unicom-web-balance"}';
  const M1_SKILL = '{"id":"m1-prepaid-web-balance"}';

  beforeEach(() => {
    sqlite.run('DELETE FROM sim_balance_web_jobs');
    sqlite.run('DELETE FROM sim_balance_checks');
  });

  test.each([
    ['china_unicom', UNICOM_SKILL],
    ['m1_prepaid', M1_SKILL],
  ])('queues a %s check with its job and event', async (provider, skillConfig) => {
    await db.batch(
      createCarrierWebBalanceStatements(db, {
        checkId: 'check-9',
        jobId: 'job-9',
        phone: { iccid: 'iccid-1' },
        profile: { ...PROFILE, skill_config: skillConfig },
        requestedBySubject: 'auth0|alice',
      }),
    );

    expect(
      one(
        v.object({ status: v.string(), requested_by_subject: v.nullable(v.string()) }),
        "SELECT status, requested_by_subject FROM sim_balance_checks WHERE id = 'check-9'",
      ),
    ).toEqual({ status: 'queued', requested_by_subject: 'auth0|alice' });
    expect(
      one(
        v.object({ provider: v.string(), status: v.string() }),
        "SELECT provider, status FROM sim_balance_web_jobs WHERE id = 'job-9'",
      ),
    ).toEqual({ provider, status: 'pending' });
    expect(
      every(
        EventRow,
        "SELECT event_type, detail_json FROM sim_balance_web_events WHERE job_id = 'job-9'",
      ),
    ).toEqual([{ event_type: 'queued', detail_json: '{}' }]);
  });

  test('leaves the check unowned by default', async () => {
    await db.batch(
      createCarrierWebBalanceStatements(db, {
        checkId: 'check-9',
        jobId: 'job-9',
        phone: { iccid: 'iccid-1' },
        profile: { ...PROFILE, skill_config: UNICOM_SKILL },
      }),
    );

    expect(
      one(
        v.object({ requested_by_subject: v.nullable(v.string()) }),
        "SELECT requested_by_subject FROM sim_balance_checks WHERE id = 'check-9'",
      ),
    ).toEqual({ requested_by_subject: null });
  });

  test.each([
    ['no skill config', undefined],
    ['a null skill config', null],
    ['an empty skill config', ''],
    ['an unknown skill', '{"id":"other"}'],
    ['a skill without an ID', '{}'],
    ['text that is not JSON', 'not json'],
  ])('refuses a profile with %s', (_case, skillConfig) => {
    const profile = skillConfig === undefined ? PROFILE : { ...PROFILE, skill_config: skillConfig };

    expect(() =>
      createCarrierWebBalanceStatements(db, {
        checkId: 'check-9',
        jobId: 'job-9',
        phone: { iccid: 'iccid-1' },
        profile,
      }),
    ).toThrow('Unsupported browser balance profile');
  });

  test('numbers a check and its job with distinct prefixed IDs', () => {
    const first = newCarrierWebBalanceIds();
    const second = newCarrierWebBalanceIds();

    expect(first.checkId).toStartWith('bal-');
    expect(first.jobId).toStartWith('webbal-');
    expect(second.checkId).not.toBe(first.checkId);
  });
});

describe('response shapes', () => {
  test('describes the claim with plain fields only', async () => {
    const response = await carrierWebBalanceHandler.claim(makeRequest());
    const body = v.parse(Fields, await response.json());

    expect(Object.keys(body).sort()).toEqual([
      'check_id',
      'id',
      'login_url',
      'otp_requested_at',
      'sim_iccid',
      'sim_index',
      'sim_number',
      'skill',
    ]);
  });
});
