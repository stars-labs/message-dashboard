import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { Schema } from '../../shared/parse-json.js';
import { createBalanceSchema } from '../../test/balance-schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { auth0Handler } from './auth0.js';
import { balanceSkillRunnerHandler } from './balance-skill-runner.js';

const API_KEY = 'secret';
const PROFILE = 'cn-mobile-sms-menu-v1';
const SIM_NUMBER = '+8613500000000';
const MENU = '11.账务查询\n12.客户服务';

const ErrorBody = v.object({ error: v.string() });
const Row = v.record(v.string(), v.unknown());
const ClaimedJob = v.object({
  id: v.string(),
  check_id: v.string(),
  step_index: v.number(),
  attempts: v.number(),
  skill: v.looseObject({ id: v.string(), max_turns: v.number() }),
  menu_options: v.array(v.object({ value: v.string(), label: v.string() })),
  response_content: v.string(),
});

let sqlite: Database;
let db: D1 & D1Batch<'run'>;
let verifySpy: Mock<typeof auth0Handler.verifyToken> | undefined;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createBalanceSchema(sqlite);
  sqlite.run(`
    INSERT INTO sims (iccid, sim_index, phone_number) VALUES ('iccid-1', 1, '${SIM_NUMBER}');
  `);
  db = sqliteD1(sqlite);
});

afterEach(() => {
  verifySpy?.mockRestore();
  verifySpy = undefined;
  sqlite.close();
});

function seedJob(
  content: string,
  { owner = null, step = 0 }: { owner?: string | null; step?: number } = {},
): void {
  sqlite
    .query(
      `INSERT INTO messages (
         id, phone_iccid, phone_number, content, type, status, filter_status, purpose
       ) VALUES ('reply-1', 'iccid-1', '10086', ?, 'received', 'received', 'filtered', 'user')`,
    )
    .run(content);
  sqlite
    .query(
      `INSERT INTO sim_balance_checks (
         id, sim_iccid, profile_id, status, response_message_id, response_sender,
         raw_response, parser_version, step_index, requested_by_subject
       ) VALUES ('check-1', 'iccid-1', ?, 'response_received', 'reply-1', '10086', ?,
         'cn-mobile-balance-v1', ?, ?)`,
    )
    .run(PROFILE, content, step, owner);
  sqlite
    .query(
      `INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index)
       VALUES ('job-1', 'check-1', 'reply-1', ?)`,
    )
    .run(step);
}

interface RequestOptions {
  id?: string;
  body?: unknown;
  rawBody?: string;
  runnerId?: string | null;
  headers?: Record<string, string>;
}

function runnerRequest({
  id,
  body,
  rawBody,
  runnerId = 'runner-1',
  headers = { 'X-API-Key': API_KEY },
}: RequestOptions = {}) {
  const query = runnerId === null ? '' : `?runner_id=${encodeURIComponent(runnerId)}`;
  const text = rawBody ?? JSON.stringify(body ?? null);
  return {
    env: { API_KEY, AUTH0_DOMAIN: 'tenant.example', DB: db },
    headers: new Headers(headers),
    url: `https://example.com/api/control/balance-skills/jobs/claim${query}`,
    params: id === undefined ? {} : { id },
    text: () => Promise.resolve(text),
  };
}

/** A device token for `subject` that carries the SMS AI scope. */
function signInDevice(subject: string): Record<string, string> {
  verifySpy?.mockRestore();
  verifySpy = spyOn(auth0Handler, 'verifyToken').mockResolvedValue({
    sub: subject,
    scope: 'balance:skills:run',
  });
  return { Authorization: 'Bearer device-jwt' };
}

function one<T>(schema: Schema<T>, sql: string): T {
  return v.parse(schema, sqlite.query(sql).get());
}

function every<T>(schema: Schema<T>, sql: string): T[] {
  return v.parse(v.array(schema), sqlite.query(sql).all());
}

async function read<T>(response: Response, schema: Schema<T>): Promise<T> {
  return v.parse(schema, await response.json());
}

async function errorOf(response: Response): Promise<string> {
  return (await read(response, ErrorBody)).error;
}

function jobState() {
  return one(
    v.object({
      status: v.string(),
      lease_owner: v.nullable(v.string()),
      lease_expires_at: v.nullable(v.string()),
      attempts: v.number(),
      last_error: v.nullable(v.string()),
    }),
    `SELECT status, lease_owner, lease_expires_at, attempts, last_error
     FROM sim_balance_skill_jobs WHERE id = 'job-1'`,
  );
}

function checkState() {
  return one(
    v.object({ status: v.string(), step_index: v.number(), error: v.nullable(v.string()) }),
    `SELECT status, step_index, error FROM sim_balance_checks WHERE id = 'check-1'`,
  );
}

async function claim(options: RequestOptions = {}) {
  const response = await balanceSkillRunnerHandler.claim(runnerRequest(options));
  expect(response.status).toBe(200);
  return read(response, ClaimedJob);
}

function decide(
  decision: unknown,
  body: Record<string, unknown> = {},
  options: RequestOptions = {},
) {
  return balanceSkillRunnerHandler.decide(
    runnerRequest({
      id: 'job-1',
      body: { runner_id: 'runner-1', model: 'company-model', decision, ...body },
      ...options,
    }),
  );
}

const REPLY = { action: 'reply', selected_option: '11', confidence: 0.98 };

describe('POST /api/control/balance-skills/jobs/claim', () => {
  test('leases the oldest pending job with its skill and the menu it must answer', async () => {
    seedJob(MENU);

    const job = await claim();

    expect(job).toMatchObject({
      id: 'job-1',
      check_id: 'check-1',
      step_index: 0,
      attempts: 1,
      skill: { id: 'readonly-balance-menu', max_turns: 4 },
      menu_options: [
        { value: '11', label: '账务查询' },
        { value: '12', label: '客户服务' },
      ],
      response_content: MENU,
    });
    expect(jobState()).toMatchObject({ status: 'leased', lease_owner: 'runner-1', attempts: 1 });
    // Whole seconds on both sides, so a second boundary between claim and read costs one.
    const { seconds } = one(
      v.object({ seconds: v.number() }),
      `SELECT strftime('%s', lease_expires_at) - strftime('%s', 'now') AS seconds
       FROM sim_balance_skill_jobs`,
    );
    expect([119, 120]).toContain(seconds);
  });

  test('re-leases a job whose lease expired', async () => {
    seedJob(MENU);
    sqlite.run(`
      UPDATE sim_balance_skill_jobs
      SET status = 'leased', lease_owner = 'runner-0', attempts = 1,
          lease_expires_at = datetime('now', '-1 seconds'), last_error = 'old';
    `);

    const job = await claim();

    expect(job.attempts).toBe(2);
    expect(jobState()).toMatchObject({ lease_owner: 'runner-1', last_error: null });
  });

  test('answers 204 when no job is waiting', async () => {
    const response = await balanceSkillRunnerHandler.claim(runnerRequest());
    expect(response.status).toBe(204);
  });

  test('does not let a legacy runner claim a Dashboard-owned job', async () => {
    seedJob(MENU, { owner: 'auth0|alice' });

    const response = await balanceSkillRunnerHandler.claim(runnerRequest());

    expect(response.status).toBe(204);
    expect(jobState().status).toBe('pending');
  });

  test('lets only the owning account claim a Dashboard-owned job', async () => {
    seedJob(MENU, { owner: 'auth0|alice' });

    const other = await balanceSkillRunnerHandler.claim(
      runnerRequest({ headers: signInDevice('auth0|bob') }),
    );
    expect(other.status).toBe(204);

    const job = await claim({ headers: signInDevice('auth0|alice') });
    expect(job.id).toBe('job-1');
  });

  test('stops a job whose skill has used its turns instead of handing it out', async () => {
    seedJob(MENU, { step: 4 });

    const response = await balanceSkillRunnerHandler.claim(runnerRequest());

    expect(response.status).toBe(204);
    expect(jobState()).toMatchObject({
      status: 'stopped',
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'Skill configuration is invalid or maximum turns reached',
    });
  });

  test('stops a job whose profile has no valid skill', async () => {
    seedJob(MENU);
    sqlite.run(`UPDATE sim_balance_profiles SET skill_config = '{}' WHERE id = '${PROFILE}'`);

    const response = await balanceSkillRunnerHandler.claim(runnerRequest());

    expect(response.status).toBe(204);
    expect(jobState().status).toBe('stopped');
  });

  test('requires runner credentials and a runner_id', async () => {
    seedJob(MENU);

    const unauthorized = await balanceSkillRunnerHandler.claim(runnerRequest({ headers: {} }));
    expect(unauthorized.status).toBe(401);
    expect(await errorOf(unauthorized)).toBe('Unauthorized');

    for (const runnerId of [null, '  ', 'r'.repeat(201)]) {
      const response = await balanceSkillRunnerHandler.claim(runnerRequest({ runnerId }));
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('runner_id is required');
    }
    expect(jobState().status).toBe('pending');
  });
});

const DecisionRow = v.object({
  check_id: v.string(),
  response_message_id: v.nullable(v.string()),
  step_index: v.number(),
  skill_id: v.string(),
  skill_version: v.string(),
  model: v.string(),
  action: v.string(),
  selected_option: v.nullable(v.string()),
  confidence: v.number(),
});

const DECISION_COLUMNS = `check_id, response_message_id, step_index, skill_id, skill_version,
  model, action, selected_option, confidence`;

describe('POST /api/control/balance-skills/jobs/:id/decision', () => {
  beforeEach(async () => {
    seedJob(MENU);
    await claim();
  });

  test('queues only a validated carrier menu option and audits the decision', async () => {
    const response = await decide(REPLY);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true, action: 'reply', status: 'queued' });
    expect(
      every(
        Row,
        `SELECT phone_iccid, phone_number, content, recipient, status, purpose, balance_check_id
         FROM messages WHERE type = 'sent'`,
      ),
    ).toEqual([
      {
        phone_iccid: 'iccid-1',
        phone_number: SIM_NUMBER,
        content: '11',
        recipient: '10086',
        status: 'sending',
        purpose: 'balance_maintenance',
        balance_check_id: 'check-1',
      },
    ]);
    expect(checkState()).toMatchObject({ status: 'queued', step_index: 1 });
    expect(jobState()).toMatchObject({ status: 'completed', lease_owner: null });
    expect(
      every(DecisionRow, `SELECT ${DECISION_COLUMNS} FROM sim_balance_skill_decisions`),
    ).toEqual([
      {
        check_id: 'check-1',
        response_message_id: 'reply-1',
        step_index: 0,
        skill_id: 'readonly-balance-menu',
        skill_version: '1',
        model: 'company-model',
        action: 'reply',
        selected_option: '11',
        confidence: 0.98,
      },
    ]);
  });

  test('stores a balance only when the AI value matches exact SMS evidence', async () => {
    sqlite.run(`
      UPDATE messages SET content = '当前可用话费余额为82.36元。' WHERE id = 'reply-1';
    `);

    const response = await decide({
      action: 'complete',
      balance: 82.36,
      currency: 'CNY',
      confidence: 0.99,
      evidence: '余额为82.36元',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, action: 'complete', status: 'parsed' });
    expect(checkState()).toMatchObject({ status: 'parsed', error: null });
    expect(
      every(Row, `SELECT metric_type, value, unit, currency, expires_at FROM sim_balance_metrics`),
    ).toEqual([
      { metric_type: 'cash_balance', value: 82.36, unit: null, currency: 'CNY', expires_at: null },
    ]);
    expect(jobState().status).toBe('completed');
  });

  test('terminalizes a safely stopped unresolved reply as unparsed', async () => {
    const response = await decide({ action: 'stop', confidence: 0.99, reason: '没有余额信息' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      action: 'stop',
      reason: '没有余额信息',
    });
    expect(checkState().status).toBe('unparsed');
    expect(jobState()).toMatchObject({ status: 'stopped', lease_owner: null });
  });

  test('turns an unsure reply into a stop rather than acting on it', async () => {
    const response = await decide({ ...REPLY, confidence: 0.5 });

    expect(response.status).toBe(200);
    expect(checkState().status).toBe('unparsed');
    expect(every(Row, `SELECT id FROM messages WHERE type = 'sent'`)).toEqual([]);
  });

  test('records an absent or empty model as unknown, and bounds a long one', async () => {
    for (const [model, stored] of [
      [undefined, 'unknown'],
      [null, 'unknown'],
      ['', 'unknown'],
      ['m'.repeat(250), 'm'.repeat(200)],
    ] as const) {
      sqlite.run(`
        DELETE FROM sim_balance_skill_decisions;
        UPDATE sim_balance_checks SET status = 'response_received';
        UPDATE sim_balance_skill_jobs SET status = 'leased', lease_owner = 'runner-1',
          lease_expires_at = datetime('now', '+1 minutes');
      `);
      const response = await decide({ action: 'stop', confidence: 0.99 }, { model });
      expect(await response.json()).toEqual({ success: true, action: 'stop', reason: '' });
      expect(
        one(v.object({ model: v.string() }), `SELECT model FROM sim_balance_skill_decisions`),
      ).toEqual({ model: stored });
    }
  });

  test('requires a runner_id and a decision', async () => {
    for (const body of [{ runner_id: 1 }, { decision: null }, { decision: 0 }, { decision: '' }]) {
      const response = await decide(REPLY, body);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('runner_id and decision are required');
    }
    for (const rawBody of ['{', 'null', '[]']) {
      const response = await balanceSkillRunnerHandler.decide(
        runnerRequest({ id: 'job-1', rawBody }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('runner_id and decision are required');
    }
    const model = await decide(REPLY, { model: 7 });
    expect(await errorOf(model)).toBe('model must be text');
    expect(jobState().status).toBe('leased');
  });

  test('rejects a malformed decision with the validator message', async () => {
    const notObject = await decide('reply');
    expect(notObject.status).toBe(400);
    expect(await errorOf(notObject)).toBe('AI decision must be an object');

    const badAction = await decide({ action: 'recharge', confidence: 1 });
    expect(badAction.status).toBe(400);
    expect(await errorOf(badAction)).toBe('AI decision has an invalid action');
  });

  test('answers 404 for an unknown job and 403 for another account', async () => {
    const missing = await balanceSkillRunnerHandler.decide(
      runnerRequest({ id: 'nope', body: { runner_id: 'runner-1', decision: REPLY } }),
    );
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toBe('Skill job not found');

    sqlite.run(`UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'`);
    const foreign = await decide(REPLY, {}, { headers: signInDevice('auth0|bob') });
    expect(foreign.status).toBe(403);
    expect(await errorOf(foreign)).toBe('Skill job belongs to another account');
  });

  test('refuses a decision without this runner holding a live lease', async () => {
    const other = await decide(REPLY, { runner_id: 'runner-2' });
    expect(other.status).toBe(409);
    expect(await errorOf(other)).toBe('Skill job lease is not active for this runner');

    for (const lease of [`datetime('now', '-1 seconds')`, 'NULL']) {
      sqlite.run(`UPDATE sim_balance_skill_jobs SET lease_expires_at = ${lease}`);
      const response = await decide(REPLY);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('Skill job lease is not active for this runner');
    }

    sqlite.run(
      `UPDATE sim_balance_skill_jobs SET status = 'pending', lease_expires_at = datetime('now', '+1 minutes')`,
    );
    expect((await decide(REPLY)).status).toBe(409);
    expect(every(Row, `SELECT id FROM messages WHERE type = 'sent'`)).toEqual([]);
  });

  test('refuses a decision once the check stopped waiting for one', async () => {
    sqlite.run(`UPDATE sim_balance_checks SET status = 'parsed'`);

    const response = await decide(REPLY);

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Balance check is no longer awaiting a skill decision');
  });

  test('refuses a decision when the profile skill became invalid', async () => {
    sqlite.run(`UPDATE sim_balance_profiles SET skill_config = '{}'`);

    const response = await decide(REPLY);

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('Balance skill configuration is invalid');
  });

  test('reports a check that moved on before a reply or a balance was applied', async () => {
    sqlite.run(`UPDATE sim_balance_checks SET step_index = 1`);

    const reply = await decide(REPLY);
    expect(reply.status).toBe(409);
    expect(await errorOf(reply)).toBe('Balance check changed before the decision was applied');
    expect(every(Row, `SELECT id FROM messages WHERE type = 'sent'`)).toEqual([]);

    sqlite.run(`UPDATE messages SET content = '余额为82.36元' WHERE id = 'reply-1'`);
    const complete = await decide({
      action: 'complete',
      balance: 82.36,
      currency: 'CNY',
      confidence: 0.99,
      evidence: '余额为82.36元',
    });
    expect(complete.status).toBe(409);
    expect(await errorOf(complete)).toBe('Balance check changed before the decision was applied');
    expect(every(Row, `SELECT id FROM sim_balance_metrics`)).toEqual([]);
  });
});

describe('POST /api/control/balance-skills/jobs/:id/release', () => {
  beforeEach(async () => {
    seedJob(MENU);
    await claim();
  });

  function release(body: unknown, options: RequestOptions = {}) {
    return balanceSkillRunnerHandler.release(runnerRequest({ id: 'job-1', body, ...options }));
  }

  test('returns a leased job to the queue with the runner reason', async () => {
    const response = await release({ runner_id: 'runner-1', error: 'model timed out' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(jobState()).toMatchObject({
      status: 'pending',
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'model timed out',
    });
  });

  test('records a default reason, and bounds a long one', async () => {
    for (const [error, stored] of [
      [undefined, 'Runner released the job'],
      [null, 'Runner released the job'],
      ['', 'Runner released the job'],
      ['e'.repeat(1200), 'e'.repeat(1000)],
    ] as const) {
      sqlite.run(`UPDATE sim_balance_skill_jobs SET status = 'leased', lease_owner = 'runner-1'`);
      await release({ runner_id: 'runner-1', error });
      expect(jobState().last_error).toBe(stored);
    }
  });

  test('requires a runner_id, and text for the error', async () => {
    for (const body of [{}, { runner_id: 7 }, null]) {
      const response = await release(body);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('runner_id is required');
    }
    const notJson = await release(null, { rawBody: '{' });
    expect(await errorOf(notJson)).toBe('runner_id is required');

    const error = await release({ runner_id: 'runner-1', error: { code: 1 } });
    expect(error.status).toBe(400);
    expect(await errorOf(error)).toBe('error must be text');
    expect(jobState().status).toBe('leased');
  });

  test('answers 404, 403 and 409 for a job this runner cannot release', async () => {
    const missing = await balanceSkillRunnerHandler.release(
      runnerRequest({ id: 'nope', body: { runner_id: 'runner-1' } }),
    );
    expect(missing.status).toBe(404);

    const other = await release({ runner_id: 'runner-2' });
    expect(other.status).toBe(409);
    expect(await errorOf(other)).toBe('Skill job lease is not active for this runner');

    sqlite.run(`UPDATE sim_balance_checks SET requested_by_subject = 'auth0|alice'`);
    const foreign = await release(
      { runner_id: 'runner-1' },
      { headers: signInDevice('auth0|bob') },
    );
    expect(foreign.status).toBe(403);
    expect(jobState().status).toBe('leased');
  });
});

describe('row schemas', () => {
  test('a job row that drifts from its schema fails the request instead of leaking', async () => {
    seedJob(MENU);
    sqlite.run(`UPDATE sim_balance_skill_jobs SET step_index = 'first'`);

    const failure = await balanceSkillRunnerHandler.claim(runnerRequest()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(v.ValiError);
  });
});
