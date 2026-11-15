// What the Balance Agent's and the ops scripts' /api/control/ routes answer on
// the wire: who each route admits, and the exact bytes of every refusal. The
// move onto the contract must leave all of it as it is.
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createBalanceSchema } from '../test/balance-schema.js';
import { sqliteD1 } from '../test/sqlite-d1.js';
import { callWorker, TEST_API_KEY } from '../test/worker-harness.js';
import { auth0Handler } from './handlers/auth0.js';
import type { AppEnv } from './worker-context.js';

type TestDb = AppEnv['DB'];

const JSON_TYPE = 'application/json;charset=utf-8';
const AUDIENCE = 'https://api.example.test';
const KEY = { 'X-API-Key': TEST_API_KEY };
const BEARER = { Authorization: 'Bearer device-jwt' };
const ALICE = 'auth0|alice';

const HEARTBEAT_SCOPE = 'balance:runners:heartbeat';
const SKILLS_SCOPE = 'balance:skills:run';
const BROWSER_SCOPE = 'balance:browser:run';

const RUNNER_ID_REQUIRED = '{"error":"runner_id is required"}';
const DECISION_REQUIRED = '{"error":"runner_id and decision are required"}';
const UNAUTHORIZED = '{"error":"Unauthorized"}';
const INTERNAL = '{"error":"Internal Server Error"}';

let sqlite: Database;
let db: TestDb;
let verifySpy: Mock<typeof auth0Handler.verifyToken>;
let errorSpy: Mock<typeof console.error>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createBalanceSchema(sqlite);
  sqlite.run(`
    INSERT INTO sims (iccid, sim_index, phone_number) VALUES ('iccid-1', 1, '+8617600419127');
    INSERT INTO messages (
      id, phone_iccid, phone_number, content, type, status, filter_status, purpose
    ) VALUES ('reply-1', 'iccid-1', '10086', '11.账务查询', 'received', 'received', 'filtered', 'user');
    INSERT INTO sim_balance_checks (
      id, sim_iccid, profile_id, status, response_message_id, response_sender,
      raw_response, parser_version, step_index
    ) VALUES (
      'check-s', 'iccid-1', 'cn-mobile-sms-menu-v1', 'response_received', 'reply-1', '10086',
      '11.账务查询', 'cn-mobile-balance-v1', 0
    );
    INSERT INTO sim_balance_skill_jobs (id, check_id, response_message_id, step_index)
    VALUES ('skill-1', 'check-s', 'reply-1', 0);
    INSERT INTO sim_balance_checks (id, sim_iccid, profile_id, status, parser_version)
    VALUES ('check-w', 'iccid-1', 'cn-unicom-browser-random-password-v1', 'queued',
      'cn-unicom-web-balance-v1');
    INSERT INTO sim_balance_web_jobs (id, check_id, provider) VALUES ('web-1', 'check-w', 'china_unicom');
  `);
  db = sqliteD1(sqlite);
  verifySpy = spyOn(auth0Handler, 'verifyToken').mockRejectedValue(new Error('bad audience'));
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  verifySpy.mockRestore();
  errorSpy.mockRestore();
  sqlite.close();
});

const untouchable: TestDb = {
  prepare: () => {
    throw new Error('database must not be read');
  },
  batch: () => {
    throw new Error('database must not be written');
  },
};

const offline: TestDb = {
  prepare: () => {
    throw new Error('D1 offline');
  },
  batch: () => {
    throw new Error('D1 offline');
  },
};

interface Send {
  headers?: Record<string, string>;
  body?: string | undefined;
  database?: TestDb;
}

async function send(method: string, path: string, { headers = KEY, body, database = db }: Send) {
  const { response } = await callWorker(method, path, {
    headers,
    ...(body === undefined ? {} : { body }),
    bindings: { DB: database, AUTH0_AUDIENCE: AUDIENCE },
  });
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type'),
    text: await response.text(),
  };
}

function answer(status: number, text: string) {
  return { status, contentType: JSON_TYPE, text };
}

const NO_CONTENT = { status: 204, contentType: null, text: '' };

function lease(table: 'sim_balance_skill_jobs' | 'sim_balance_web_jobs', runnerId = 'runner-1') {
  sqlite.run(
    `UPDATE ${table} SET status = 'leased', lease_owner = ?,
       lease_expires_at = datetime('now', '+120 seconds')`,
    [runnerId],
  );
}

function ownBy(subject: string) {
  sqlite.run('UPDATE sim_balance_checks SET requested_by_subject = ?', [subject]);
}

/**
 * Every runner route, its scope, and what it answers a caller it admits when
 * the request carries no runner_id and a body that is not JSON: its own first
 * refusal, reached without D1.
 */
const RUNNER_ROUTES: [string, string, string, ReturnType<typeof answer>][] = [
  ['GET', '/api/control/balance-runners/check', HEARTBEAT_SCOPE, answer(200, '{"success":true}')],
  [
    'POST',
    '/api/control/balance-runners/heartbeat',
    HEARTBEAT_SCOPE,
    answer(400, '{"error":"Body must be JSON"}'),
  ],
  ['GET', '/api/control/balance-skills/jobs/claim', SKILLS_SCOPE, answer(400, RUNNER_ID_REQUIRED)],
  [
    'POST',
    '/api/control/balance-skills/jobs/skill-1/decision',
    SKILLS_SCOPE,
    answer(400, DECISION_REQUIRED),
  ],
  [
    'POST',
    '/api/control/balance-skills/jobs/skill-1/release',
    SKILLS_SCOPE,
    answer(400, RUNNER_ID_REQUIRED),
  ],
  [
    'GET',
    '/api/control/carrier-web-balance/jobs/claim',
    BROWSER_SCOPE,
    answer(400, RUNNER_ID_REQUIRED),
  ],
  ...['otp-requested', 'heartbeat', 'complete', 'fail', 'release'].map(
    (action): [string, string, string, ReturnType<typeof answer>] => [
      'POST',
      `/api/control/carrier-web-balance/jobs/web-1/${action}`,
      BROWSER_SCOPE,
      answer(400, RUNNER_ID_REQUIRED),
    ],
  ),
  [
    'GET',
    '/api/control/carrier-web-balance/jobs/web-1/otp',
    BROWSER_SCOPE,
    answer(400, RUNNER_ID_REQUIRED),
  ],
];

function bodyFor(method: string): string | undefined {
  return method === 'POST' ? '{' : undefined;
}

describe('who a runner route admits', () => {
  const refused: [
    string,
    Record<string, string>,
    ((scope: string) => Record<string, unknown>) | null,
  ][] = [
    ['no credentials', {}, null],
    ['a wrong API key', { 'X-API-Key': 'wrong' }, null],
    ['a token Auth0 does not verify', BEARER, null],
    ['a token with no subject', BEARER, (scope) => ({ scope })],
    ['a token with an empty subject', BEARER, (scope) => ({ sub: '', scope })],
    ['a token with another scope', BEARER, () => ({ sub: ALICE, scope: 'balance:other' })],
    ['a token whose scope is not text', BEARER, () => ({ sub: ALICE, scope: 5 })],
    [
      'a token whose permissions are not a list',
      BEARER,
      (scope) => ({ sub: ALICE, permissions: scope }),
    ],
    ['a credential that is not a bearer token', { Authorization: 'Basic device-jwt' }, null],
    ['an empty bearer token', { Authorization: 'Bearer   ' }, null],
  ];

  test.each(refused)(
    'refuses %s on every route, before the body or D1',
    async (_c, headers, claims) => {
      for (const [method, path, scope] of RUNNER_ROUTES) {
        if (claims !== null) verifySpy.mockResolvedValue(claims(scope));
        const wire = await send(method, path, {
          headers,
          body: bodyFor(method),
          database: untouchable,
        });
        expect([method, path, wire]).toEqual([method, path, answer(401, UNAUTHORIZED)]);
      }
    },
  );

  test('refuses a token that carries another runner route scope', async () => {
    for (const [method, path, scope] of RUNNER_ROUTES) {
      const other = [HEARTBEAT_SCOPE, SKILLS_SCOPE, BROWSER_SCOPE].filter((s) => s !== scope);
      verifySpy.mockResolvedValue({ sub: ALICE, scope: other.join(' '), permissions: other });
      const wire = await send(method, path, {
        headers: BEARER,
        body: bodyFor(method),
        database: untouchable,
      });
      expect([method, path, wire]).toEqual([method, path, answer(401, UNAUTHORIZED)]);
    }
  });

  const admitted: [
    string,
    Record<string, string>,
    ((scope: string) => Record<string, unknown>) | null,
  ][] = [
    ['the API key', KEY, null],
    ['the API key beside a token Auth0 does not verify', { ...KEY, ...BEARER }, null],
    [
      'a token with the scope among others',
      BEARER,
      (scope) => ({ sub: ALICE, scope: `a ${scope} b` }),
    ],
    [
      'a token with the scope as a permission',
      BEARER,
      (scope) => ({ sub: ALICE, permissions: [scope] }),
    ],
    [
      'a lower-case bearer token',
      { Authorization: 'bearer device-jwt' },
      (scope) => ({ sub: ALICE, scope }),
    ],
  ];

  test.each(admitted)('admits %s on every route', async (_c, headers, claims) => {
    for (const [method, path, scope, own] of RUNNER_ROUTES) {
      verifySpy.mockClear();
      if (claims === null) verifySpy.mockRejectedValue(new Error('bad audience'));
      else verifySpy.mockResolvedValue(claims(scope));
      const wire = await send(method, path, {
        headers,
        body: bodyFor(method),
        database: untouchable,
      });
      expect([method, path, wire]).toEqual([method, path, own]);
      if (claims === null) expect(verifySpy).not.toHaveBeenCalled();
    }
  });

  test('verifies the token against the Worker audience', async () => {
    verifySpy.mockResolvedValue({ sub: ALICE, scope: HEARTBEAT_SCOPE });
    await send('GET', '/api/control/balance-runners/check', { headers: BEARER });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy.mock.calls[0]?.[0]).toBe('device-jwt');
    expect(verifySpy.mock.calls[0]?.[1]).toMatchObject({ AUTH0_AUDIENCE: AUDIENCE });
  });
});

describe('runner refusals on the wire', () => {
  const HEARTBEAT = JSON.stringify({
    runner_id: 'runner-1',
    session_id: 'session-1',
    display_name: 'Runner',
    platform: 'darwin',
    version: '1.0.0',
    capabilities: [],
  });

  test('runner heartbeat', async () => {
    const path = '/api/control/balance-runners/heartbeat';
    const invalid = answer(400, '{"error":"Invalid runner heartbeat"}');
    for (const [body, expected] of [
      ['', answer(400, '{"error":"Body must be JSON"}')],
      ['[]', invalid],
      ['{}', invalid],
      ['{"runner_id":"runner-1"}', invalid],
    ] as const) {
      expect([body, await send('POST', path, { body, database: untouchable })]).toEqual([
        body,
        expected,
      ]);
    }
    expect(await send('POST', path, { body: HEARTBEAT, database: offline })).toEqual(
      answer(500, INTERNAL),
    );

    sqlite.run(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version
      ) VALUES ('runner-1', 'Runner', 'auth0_device', '${ALICE}', 'darwin', '1')
    `);
    expect(await send('POST', path, { body: HEARTBEAT })).toEqual(
      answer(409, '{"error":"Runner identity does not match this installation"}'),
    );
    sqlite.run('UPDATE balance_runner_installations SET revoked_at = CURRENT_TIMESTAMP');
    expect(await send('POST', path, { body: HEARTBEAT })).toEqual(
      answer(403, '{"error":"Runner installation is revoked"}'),
    );
  });

  test('skill and web claims', async () => {
    for (const base of [
      '/api/control/balance-skills/jobs/claim',
      '/api/control/carrier-web-balance/jobs/claim',
    ]) {
      for (const query of [
        '',
        '?runner_id=',
        '?runner_id=%20%20',
        `?runner_id=${'r'.repeat(201)}`,
      ]) {
        expect([query, await send('GET', `${base}${query}`, { database: untouchable })]).toEqual([
          query,
          answer(400, RUNNER_ID_REQUIRED),
        ]);
      }
      expect(await send('GET', `${base}?runner_id=runner-1`, { database: offline })).toEqual(
        answer(500, INTERNAL),
      );
    }

    ownBy(ALICE);
    for (const base of [
      '/api/control/balance-skills/jobs/claim',
      '/api/control/carrier-web-balance/jobs/claim',
    ]) {
      expect(await send('GET', `${base}?runner_id=runner-1`, {})).toEqual(NO_CONTENT);
    }
  });

  test('skill decision', async () => {
    const path = '/api/control/balance-skills/jobs/skill-1/decision';
    const decide = (body: object) => JSON.stringify({ runner_id: 'runner-1', ...body });
    for (const body of [
      '',
      '{',
      '[]',
      '{}',
      '{"runner_id":5,"decision":{}}',
      '{"runner_id":"runner-1"}',
      '{"runner_id":"runner-1","decision":0}',
    ]) {
      expect([body, await send('POST', path, { body, database: untouchable })]).toEqual([
        body,
        answer(400, DECISION_REQUIRED),
      ]);
    }
    expect(
      await send('POST', path, { body: decide({ decision: {}, model: 5 }), database: untouchable }),
    ).toEqual(answer(400, '{"error":"model must be text"}'));

    const valid = decide({ decision: { action: 'stop', reason: 'done' } });
    for (const id of ['nope', '']) {
      expect(
        await send('POST', `/api/control/balance-skills/jobs/${id}/decision`, { body: valid }),
      ).toEqual(answer(404, '{"error":"Skill job not found"}'));
    }
    expect(await send('POST', path, { body: valid })).toEqual(
      answer(409, '{"error":"Skill job lease is not active for this runner"}'),
    );
    lease('sim_balance_skill_jobs');
    expect(await send('POST', path, { body: decide({ decision: 'stop' }) })).toEqual(
      answer(400, '{"error":"AI decision must be an object"}'),
    );
    expect(await send('POST', path, { body: decide({ decision: { action: 'dance' } }) })).toEqual(
      answer(400, '{"error":"AI decision has an invalid action"}'),
    );
    sqlite.run("UPDATE sim_balance_checks SET status = 'parsed' WHERE id = 'check-s'");
    expect(await send('POST', path, { body: valid })).toEqual(
      answer(409, '{"error":"Balance check is no longer awaiting a skill decision"}'),
    );
    ownBy(ALICE);
    expect(await send('POST', path, { body: valid })).toEqual(
      answer(403, '{"error":"Skill job belongs to another account"}'),
    );
    expect(await send('POST', path, { body: valid, database: offline })).toEqual(
      answer(500, INTERNAL),
    );
  });

  test('skill release', async () => {
    const path = '/api/control/balance-skills/jobs/skill-1/release';
    for (const body of ['', '{', '[]', '{}', '{"runner_id":5}']) {
      expect([body, await send('POST', path, { body, database: untouchable })]).toEqual([
        body,
        answer(400, RUNNER_ID_REQUIRED),
      ]);
    }
    expect(
      await send('POST', path, {
        body: '{"runner_id":"runner-1","error":5}',
        database: untouchable,
      }),
    ).toEqual(answer(400, '{"error":"error must be text"}'));

    const valid = '{"runner_id":"runner-1"}';
    for (const id of ['nope', '']) {
      expect(
        await send('POST', `/api/control/balance-skills/jobs/${id}/release`, { body: valid }),
      ).toEqual(answer(404, '{"error":"Skill job not found"}'));
    }
    expect(await send('POST', path, { body: valid })).toEqual(
      answer(409, '{"error":"Skill job lease is not active for this runner"}'),
    );
    ownBy(ALICE);
    expect(await send('POST', path, { body: valid })).toEqual(
      answer(403, '{"error":"Skill job belongs to another account"}'),
    );
    expect(await send('POST', path, { body: valid, database: offline })).toEqual(
      answer(500, INTERNAL),
    );
  });

  test('every web job action refuses a job it cannot act on', async () => {
    const valid = '{"runner_id":"runner-1","status":"authenticating","balance":1,"currency":"CNY"}';
    for (const action of ['otp-requested', 'heartbeat', 'complete', 'fail', 'release']) {
      const path = `/api/control/carrier-web-balance/jobs/web-1/${action}`;
      sqlite.run(
        `UPDATE sim_balance_web_jobs SET status = 'pending', lease_owner = NULL,
           lease_expires_at = NULL, otp_requested_at = NULL`,
      );
      sqlite.run(
        "UPDATE sim_balance_checks SET status = 'queued', requested_by_subject = NULL WHERE id = 'check-w'",
      );
      const cases: [string, string, ReturnType<typeof answer>][] = [
        ...['', '{', '[]', '{}', '{"runner_id":5}'].map(
          (body): [string, string, ReturnType<typeof answer>] => [
            path,
            body,
            answer(400, RUNNER_ID_REQUIRED),
          ],
        ),
        [
          `/api/control/carrier-web-balance/jobs/nope/${action}`,
          valid,
          answer(404, '{"error":"Web balance job not found"}'),
        ],
        [
          `/api/control/carrier-web-balance/jobs//${action}`,
          valid,
          answer(404, '{"error":"Web balance job not found"}'),
        ],
        [
          path,
          valid,
          answer(409, '{"error":"Web balance job lease is not active for this runner"}'),
        ],
      ];
      for (const [target, body, expected] of cases) {
        expect([action, body, await send('POST', target, { body })]).toEqual([
          action,
          body,
          expected,
        ]);
      }
      lease('sim_balance_web_jobs');
      sqlite.run("UPDATE sim_balance_checks SET status = 'parsed' WHERE id = 'check-w'");
      expect([action, await send('POST', path, { body: valid })]).toEqual([
        action,
        answer(409, '{"error":"Balance check is no longer queued"}'),
      ]);
      ownBy(ALICE);
      expect([action, await send('POST', path, { body: valid })]).toEqual([
        action,
        answer(403, '{"error":"Web balance job belongs to another account"}'),
      ]);
      expect([action, await send('POST', path, { body: valid, database: offline })]).toEqual([
        action,
        answer(500, INTERNAL),
      ]);
    }
  });

  test('web job actions refuse a body they cannot use', async () => {
    lease('sim_balance_web_jobs');
    const web = (action: string) => `/api/control/carrier-web-balance/jobs/web-1/${action}`;
    const cases: [string, string, ReturnType<typeof answer>][] = [
      ['heartbeat', '{"runner_id":"runner-1"}', answer(400, '{"error":"Invalid web job status"}')],
      [
        'heartbeat',
        '{"runner_id":"runner-1","status":"done"}',
        answer(400, '{"error":"Invalid web job status"}'),
      ],
      [
        'heartbeat',
        '{"runner_id":"runner-1","status":"authenticating","reason":5}',
        answer(400, '{"error":"reason must be text"}'),
      ],
      ['complete', '{"runner_id":"runner-1"}', answer(400, '{"error":"balance is invalid"}')],
      [
        'complete',
        '{"runner_id":"runner-1","balance":"1"}',
        answer(400, '{"error":"balance is invalid"}'),
      ],
      [
        'complete',
        '{"runner_id":"runner-1","balance":1}',
        answer(400, '{"error":"currency must be CNY"}'),
      ],
      [
        'complete',
        '{"runner_id":"runner-1","balance":1,"currency":"CNY","account_number":"1"}',
        answer(409, '{"error":"Authenticated account does not match the balance task SIM"}'),
      ],
      ['fail', '{"runner_id":"runner-1","error":5}', answer(400, '{"error":"error must be text"}')],
      [
        'release',
        '{"runner_id":"runner-1","error":5}',
        answer(400, '{"error":"error must be text"}'),
      ],
    ];
    for (const [action, body, expected] of cases) {
      expect([action, body, await send('POST', web(action), { body })]).toEqual([
        action,
        body,
        expected,
      ]);
    }

    sqlite.run(`
      UPDATE sims SET phone_number = '+6590950236';
      UPDATE sim_balance_checks SET profile_id = 'sg-m1-prepaid-browser-v1',
        parser_version = 'sg-m1-prepaid-web-balance-v1' WHERE id = 'check-w';
      UPDATE sim_balance_web_jobs SET provider = 'm1_prepaid';
    `);
    expect(
      await send('POST', web('complete'), {
        body: '{"runner_id":"runner-1","balance":1,"currency":"SGD","account_number":"90950236","expires_at":"2026-02-30"}',
      }),
    ).toEqual(answer(400, '{"error":"expires_at must be a real ISO calendar date"}'));
  });

  test('OTP request and read', async () => {
    const requested = '/api/control/carrier-web-balance/jobs/web-1/otp-requested';
    const otp = '/api/control/carrier-web-balance/jobs/web-1/otp';
    expect(
      await send('GET', '/api/control/carrier-web-balance/jobs/nope/otp?runner_id=runner-1', {}),
    ).toEqual(answer(404, '{"error":"Web balance job not found"}'));
    lease('sim_balance_web_jobs');
    expect(await send('GET', `${otp}?runner_id=`, {})).toEqual(
      answer(409, '{"error":"Web balance job lease is not active for this runner"}'),
    );
    expect(await send('GET', `${otp}?runner_id=runner-1`, {})).toEqual(
      answer(409, '{"error":"OTP has not been requested"}'),
    );
    expect(await send('POST', requested, { body: '{"runner_id":"runner-1"}' })).toEqual(
      answer(200, '{"success":true,"status":"awaiting_otp"}'),
    );
    expect(await send('POST', requested, { body: '{"runner_id":"runner-1"}' })).toEqual(
      answer(409, '{"error":"OTP was already requested for this job"}'),
    );
    expect(await send('GET', `${otp}?runner_id=runner-1`, {})).toEqual(NO_CONTENT);
    expect(await send('GET', `${otp}?runner_id=runner-1`, { database: offline })).toEqual(
      answer(500, INTERNAL),
    );
  });
});

describe('ops balance-check refusals on the wire', () => {
  const ROUTES = [
    '/api/control/balance-checks',
    '/api/control/balance-checks/continue',
    '/api/control/balance-checks/retry',
    '/api/control/balance-checks/stop',
  ];

  test('every route refuses a caller without the API key, before the body or D1', async () => {
    verifySpy.mockResolvedValue({
      sub: ALICE,
      scope: 'balance:runners:heartbeat balance:skills:run balance:browser:run',
    });
    for (const path of ROUTES) {
      for (const headers of [{}, { 'X-API-Key': 'wrong' }, BEARER]) {
        expect([
          path,
          await send('POST', path, { headers, body: '{', database: untouchable }),
        ]).toEqual([path, answer(401, UNAUTHORIZED)]);
      }
    }
  });

  test('every route refuses a body it cannot read', async () => {
    const required: Record<string, string> = {
      '/api/control/balance-checks': 'phone_iccid and profile_id are required',
      '/api/control/balance-checks/continue': 'check_id is required',
      '/api/control/balance-checks/retry': 'check_id is required',
      '/api/control/balance-checks/stop': 'check_id is required',
    };
    for (const path of ROUTES) {
      const missing = answer(400, JSON.stringify({ success: false, error: required[path] }));
      for (const [body, expected] of [
        ['', answer(400, '{"success":false,"error":"Invalid JSON body"}')],
        ['{', answer(400, '{"success":false,"error":"Invalid JSON body"}')],
        ['[]', missing],
        ['{}', missing],
        ['{"phone_iccid":5,"profile_id":5,"check_id":5}', missing],
      ] as const) {
        expect([path, body, await send('POST', path, { body, database: untouchable })]).toEqual([
          path,
          body,
          expected,
        ]);
      }
    }
  });

  test('each route refuses a check or profile it cannot act on', async () => {
    const cases: [string, string, ReturnType<typeof answer>][] = [
      [
        '/api/control/balance-checks',
        '{"phone_iccid":"iccid-1","profile_id":"nope"}',
        answer(404, '{"success":false,"error":"Balance profile is not enabled"}'),
      ],
      [
        '/api/control/balance-checks/continue',
        '{"check_id":"nope"}',
        answer(404, '{"success":false,"error":"Balance check not found"}'),
      ],
      [
        '/api/control/balance-checks/stop',
        '{"check_id":"nope"}',
        answer(404, '{"success":false,"error":"Balance check not found"}'),
      ],
      [
        '/api/control/balance-checks/stop',
        '{"check_id":"check-w"}',
        answer(409, '{"success":false,"error":"Balance check is not stoppable"}'),
      ],
    ];
    for (const [path, body, expected] of cases) {
      expect([path, body, await send('POST', path, { body })]).toEqual([path, body, expected]);
    }
  });

  test('a D1 failure escapes to the Worker 500', async () => {
    for (const path of ROUTES) {
      const body =
        '{"phone_iccid":"iccid-1","profile_id":"cn-mobile-sms-menu-v1","check_id":"check-s"}';
      expect([path, await send('POST', path, { body, database: offline })]).toEqual([
        path,
        answer(500, INTERNAL),
      ]);
    }
  });
});
