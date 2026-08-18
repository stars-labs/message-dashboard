import { describe, expect, test } from 'bun:test';
import {
  balanceQueriesHandler,
  buildBalanceQueryPlan,
  carrierMatchesProfile,
  describeBalanceMethod,
  expectedSenderMatches,
  filterBalancePlanByMethods,
  findPendingBalanceCheck,
  linkBalanceReply,
  parseBalanceMetrics,
  updateBalanceCheckForSmsResult,
} from './balance-queries.js';

const profile = {
  id: 'cn-mobile-sms-menu-v1',
  country_code: 'CN',
  carrier: 'China Mobile',
  method: 'sms',
  command: '10086',
  destination: '10086',
  expected_senders: '["10086"]',
  parser_version: 'cn-mobile-balance-v1',
  conversation_steps: '[{"response_contains":"1.话费与AI豆","command":"1"},{"response_contains":"101.查询余额","command":"101"}]',
  response_window_minutes: 30,
  discovery_enabled: 1,
  enabled: 0,
};

const phone = {
  iccid: '898600520121F0517883',
  number: '+8613520607015',
  carrier: '移动',
  country: 'CN',
  sim_status: 'active',
};

function dbStub({ profileResult = profile, phoneResult = phone, recent = null } = {}) {
  const calls = [];
  const batches = [];

  const db = {
    calls,
    batches,
    prepare(sql) {
      return {
        bind(...params) {
          const statement = {
            sql,
            params,
            async first() {
              calls.push({ operation: 'first', sql, params });
              if (sql.includes('FROM sim_balance_profiles')) return profileResult;
              if (sql.includes('FROM device_view')) return phoneResult;
              if (sql.includes('FROM sim_balance_checks')) return recent;
              return null;
            },
            async all() {
              calls.push({ operation: 'all', sql, params });
              return { results: [] };
            },
            async run() {
              calls.push({ operation: 'run', sql, params });
              return { meta: { changes: 1 } };
            },
          };
          return statement;
        },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };

  return db;
}

function request(db, body = {}, apiKey = 'secret') {
  return {
    env: { API_KEY: 'secret', DB: db },
    user: { id: 'auth0|dashboard-user' },
    headers: new Headers({ 'X-API-Key': apiKey }),
    json: async () => body,
  };
}

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

  test('matches only a configured service sender', () => {
    expect(expectedSenderMatches('10086', '["10086"]')).toBe(true);
    expect(expectedSenderMatches('+8610086', '["10086"]')).toBe(true);
    expect(expectedSenderMatches('10086100', '["10086"]')).toBe(false);
    expect(expectedSenderMatches('10086', 'not-json')).toBe(false);
  });
});

describe('balance query execution requirements', () => {
  test('classifies direct, AI-assisted and browser profiles', () => {
    expect(describeBalanceMethod({ method: 'sms', skill_config: null }))
      .toEqual({ category: 'direct_sms', capability: null, interactive: false });
    expect(describeBalanceMethod({
      method: 'sms',
      skill_config: JSON.stringify({
        id: 'balance-menu', version: '1', objective: 'Read balance',
        max_turns: 2, minimum_confidence: 0.9, currencies: ['CNY'],
        forbidden_intents: ['recharge'],
      }),
    })).toEqual({ category: 'sms_ai', capability: 'sms_ai', interactive: false });
    expect(describeBalanceMethod({ method: 'browser' }))
      .toEqual({ category: 'browser', capability: 'unicom_browser', interactive: true });
  });
});

describe('balance-query planning', () => {
  const enabledProfile = { ...profile, enabled: 1, discovery_enabled: 0 };

  test('allows every matching active SIM for an enabled profile', () => {
    const plan = buildBalanceQueryPlan({
      phones: [phone, { ...phone, iccid: 'second' }],
      profiles: [enabledProfile],
    });
    expect(plan.every((item) => item.eligible)).toBe(true);
  });

  test('selects an enabled browser profile for China Unicom', () => {
    const browserProfile = {
      ...enabledProfile,
      id: 'cn-unicom-browser-random-password-v1',
      carrier: 'China Unicom',
      method: 'browser',
    };
    const [item] = buildBalanceQueryPlan({
      phones: [{ ...phone, carrier: '联通' }],
      profiles: [browserProfile],
    });
    expect(item).toMatchObject({ eligible: true, profile: browserProfile });
  });

  test('limits discovery profiles in a batch to SIMs with a parsed result', () => {
    const plan = buildBalanceQueryPlan({
      phones: [phone, { ...phone, iccid: 'second' }],
      profiles: [profile],
      successfulChecks: [{ sim_iccid: phone.iccid, profile_id: profile.id }],
    });
    expect(plan[0].eligible).toBe(true);
    expect(plan[1]).toMatchObject({ eligible: false, reason: 'unverified' });
  });

  test('allows an explicit single-SIM discovery query but still enforces cooldown', () => {
    const [available] = buildBalanceQueryPlan({
      phones: [phone], profiles: [profile], allowDiscovery: true,
    });
    const [cooldown] = buildBalanceQueryPlan({
      phones: [phone],
      profiles: [profile],
      allowDiscovery: true,
      recentChecks: [{ sim_iccid: phone.iccid, id: 'recent' }],
    });
    expect(available.eligible).toBe(true);
    expect(cooldown).toMatchObject({ eligible: false, reason: 'cooldown' });
  });

  test('skips offline and unsupported cards with explicit reasons', () => {
    const plan = buildBalanceQueryPlan({
      phones: [
        { ...phone, sim_status: 'offline' },
        { ...phone, iccid: 'sg', country: 'SG', carrier: 'Singtel' },
      ],
      profiles: [enabledProfile],
    });
    expect(plan.map((item) => item.reason)).toEqual(['offline', 'unsupported']);
  });

  test('marks secondary SIMs ineligible with the secondary reason', () => {
    const plan = buildBalanceQueryPlan({
      phones: [
        { ...phone, iccid: 'primary-card', sim_role: 'primary' },
        { ...phone, iccid: 'secondary-card', sim_role: 'secondary' },
        { ...phone, iccid: 'standalone-card', sim_role: 'standalone' },
        { ...phone, sim_role: undefined },
      ],
      profiles: [enabledProfile],
    });
    expect(plan[0]).toMatchObject({ eligible: true, reason: null });
    expect(plan[1]).toMatchObject({ eligible: false, reason: 'secondary' });
    expect(plan[2]).toMatchObject({ eligible: true, reason: null });
    expect(plan[3]).toMatchObject({ eligible: true, reason: null });
  });

  test('queues only the explicitly confirmed batch method categories', () => {
    const plan = [
      { eligible: true, profile: { method: 'sms', skill_config: null }, phone: { iccid: 'direct' } },
      { eligible: true, profile: { method: 'sms', skill_config: JSON.stringify({ id: 'skill', version: '1', objective: 'balance' }) }, phone: { iccid: 'ai' } },
      { eligible: true, profile: { method: 'browser' }, phone: { iccid: 'browser' } },
      { eligible: false, profile: { method: 'sms' }, phone: { iccid: 'offline' } },
    ];
    expect(filterBalancePlanByMethods(plan, ['direct_sms', 'sms_ai'])
      .map((item) => item.phone.iccid)).toEqual(['direct', 'ai']);
    expect(filterBalancePlanByMethods(plan, ['browser'])
      .map((item) => item.phone.iccid)).toEqual(['browser']);
  });
});

describe('POST /api/balance-checks/query-batch', () => {
  test('rejects absent, duplicate, or unknown method selections before loading the plan', async () => {
    for (const methods of [undefined, [], ['browser', 'browser'], ['ussd']]) {
      const response = await balanceQueriesHandler.queryBatch({
        user: { id: 'auth0|dashboard-user' },
        json: async () => ({ methods }),
        env: {
          DB: { prepare: () => { throw new Error('database must not be read'); } },
        },
      });
      expect(response.status).toBe(400);
    }
  });

  test('requires a bounded unique SIM scope', async () => {
    for (const phoneIccids of [undefined, [], [phone.iccid, phone.iccid], [null]]) {
      const response = await balanceQueriesHandler.queryBatch({
        user: { id: 'auth0|dashboard-user' },
        json: async () => ({ methods: ['browser'], phone_iccids: phoneIccids }),
        env: {
          DB: { prepare: () => { throw new Error('database must not be read'); } },
        },
      });
      expect(response.status).toBe(400);
    }
  });
});

describe('POST /api/balance-checks/query-preview', () => {
  test('limits planning to the explicit SIM scope', async () => {
    const secondPhone = { ...phone, iccid: '89860117811049221140', sim_index: 3 };
    let deviceParams = null;
    const db = {
      prepare(sql) {
        const execute = async (params = []) => {
          if (sql.includes('FROM device_view')) {
            deviceParams = params;
            return { results: [phone, secondPhone] };
          }
          if (sql.includes('FROM sim_balance_profiles')) {
            return { results: [{ ...profile, enabled: 1, discovery_enabled: 0 }] };
          }
          return { results: [] };
        };
        return {
          all: () => execute(),
          bind(...params) { return { all: () => execute(params) }; },
        };
      },
    };
    const response = await balanceQueriesHandler.preview({
      method: 'POST',
      env: { DB: db },
      user: { id: 'auth0|dashboard-user' },
      json: async () => ({ phone_iccids: [phone.iccid, secondPhone.iccid] }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(deviceParams).toEqual([phone.iccid, secondPhone.iccid]);
    expect(body.summary.total).toBe(2);
    expect(body.summary.eligible).toBe(2);
  });
});

describe('POST /api/balance-checks/query', () => {
  test('routes an explicit China Unicom query to the browser profile', async () => {
    const browserProfile = {
      ...profile,
      id: 'cn-unicom-browser-random-password-v1',
      carrier: 'China Unicom',
      method: 'browser',
      parser_version: 'cn-unicom-web-balance-v1',
    };
    const smsProfile = {
      ...profile,
      id: 'cn-unicom-sms-cxye-v1',
      carrier: 'China Unicom',
      command: 'CXYE',
      destination: '10010',
    };
    const unicomPhone = { ...phone, carrier: '联通' };
    const batches = [];
    const db = {
      prepare(sql) {
        const execute = (params = []) => ({
          async all() {
            if (sql.includes('FROM device_view')) return { results: [unicomPhone] };
            if (sql.includes('FROM sim_balance_profiles')) {
              expect(sql).toContain("method IN ('sms', 'browser')");
              return { results: [browserProfile, smsProfile] };
            }
            return { results: [] };
          },
        });
        return {
          ...execute(),
          bind(...params) {
            const statement = { sql, params, ...execute(params) };
            return statement;
          },
        };
      },
      async batch(statements) {
        batches.push(statements);
        return statements.map(() => ({ success: true }));
      },
    };

    const response = await balanceQueriesHandler.query(request(db, {
      phone_iccid: unicomPhone.iccid,
    }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.check.profile_id).toBe(browserProfile.id);
    const checkInsert = batches[0].find((statement) =>
      statement.sql.includes('INSERT INTO sim_balance_checks')
    );
    expect(checkInsert.params.at(-1)).toBe('auth0|dashboard-user');
    expect(batches[0].some((statement) => statement.sql.includes('sim_balance_web_jobs'))).toBe(true);
    expect(batches[0].some((statement) => statement.sql.includes('INSERT INTO messages'))).toBe(false);
  });
});

describe('GET /api/balance-checks/query-preflight', () => {
  test('describes an interactive browser query and current runner availability', async () => {
    const browserProfile = {
      ...profile,
      id: 'cn-unicom-browser-random-password-v1',
      carrier: 'China Unicom',
      method: 'browser',
      enabled: 1,
      discovery_enabled: 0,
    };
    const unicomPhone = {
      ...phone,
      carrier: '联通',
      sim_index: 20,
    };
    const db = {
      prepare(sql) {
        const execute = async () => {
          if (sql.includes('FROM device_view')) return { results: [unicomPhone] };
          if (sql.includes('FROM sim_balance_profiles')) return { results: [browserProfile] };
          if (sql.includes('FROM balance_runner_installations')) {
            return { results: [{
              id: 'runner-1', display_name: 'Runner', auth_mode: 'auth0_device',
              auth_subject: 'auth0|dashboard-user',
              platform: 'darwin', version: '1', last_heartbeat: '2026-08-15 03:00:00',
              seconds_since_heartbeat: 10,
            }] };
          }
          if (sql.includes('FROM balance_runner_capabilities')) {
            return { results: [{
              runner_id: 'runner-1', capability: 'unicom_browser', state: 'ready',
              current_job_id: null, concurrency: 1, detail_code: null,
              last_heartbeat: '2026-08-15 03:00:00', seconds_since_heartbeat: 10,
            }] };
          }
          return { results: [] };
        };
        return {
          all: execute,
          bind() { return { all: execute }; },
        };
      },
    };

    const response = await balanceQueriesHandler.preflight({
      env: { DB: db },
      user: { id: 'auth0|dashboard-user' },
      url: `https://example.com/api/balance-checks/query-preflight?phone_iccid=${unicomPhone.iccid}`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      eligible: true,
      method: { category: 'browser', capability: 'unicom_browser', interactive: true },
      runner: { required: true, available: true, state: 'ready' },
    });
  });
});

describe('POST /api/control/balance-checks', () => {
  test('rejects an invalid API key before reading the body', async () => {
    const db = dbStub();
    let bodyRead = false;
    const req = request(db, {}, 'wrong');
    req.json = async () => {
      bodyRead = true;
      return {};
    };

    const response = await balanceQueriesHandler.create(req);
    expect(response.status).toBe(401);
    expect(bodyRead).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test('queues only the allowlisted destination and command', async () => {
    const db = dbStub();
    const response = await balanceQueriesHandler.create(request(db, {
      phone_iccid: phone.iccid,
      profile_id: profile.id,
      destination: '+6599999999',
      command: 'SUBSCRIBE',
    }));

    expect(response.status).toBe(202);
    expect(db.batches).toHaveLength(1);

    const messageInsert = db.batches[0].find((statement) =>
      statement.sql.includes('INSERT INTO messages')
    );
    expect(messageInsert.params[1]).toBe(phone.iccid);
    expect(messageInsert.params[2]).toBe(phone.number);
    expect(messageInsert.params[3]).toBe('10086');
    expect(messageInsert.params[4]).toBe('10086');
    expect(messageInsert.params).not.toContain('SUBSCRIBE');
    expect(messageInsert.params).not.toContain('+6599999999');
  });

  test('creates a browser job without queueing an outbound SMS', async () => {
    const browserProfile = {
      ...profile,
      id: 'cn-unicom-browser-random-password-v1',
      carrier: 'China Unicom',
      method: 'browser',
      parser_version: 'cn-unicom-web-balance-v1',
    };
    const db = dbStub({
      profileResult: browserProfile,
      phoneResult: { ...phone, carrier: '联通' },
    });
    const response = await balanceQueriesHandler.create(request(db, {
      phone_iccid: phone.iccid,
      profile_id: browserProfile.id,
    }));

    expect(response.status).toBe(202);
    expect(db.batches[0].some((statement) => statement.sql.includes('sim_balance_web_jobs'))).toBe(true);
    expect(db.batches[0].some((statement) => statement.sql.includes('INSERT INTO messages'))).toBe(false);
  });

  test('rejects an offline SIM', async () => {
    const db = dbStub({ phoneResult: { ...phone, sim_status: 'offline' } });
    const response = await balanceQueriesHandler.create(request(db, {
      phone_iccid: phone.iccid,
      profile_id: profile.id,
    }));

    expect(response.status).toBe(409);
    expect(db.batches).toHaveLength(0);
  });

  test('enforces the per-SIM 24-hour limit', async () => {
    const db = dbStub({
      recent: { id: 'bal-previous', status: 'awaiting_response', requested_at: '2026-08-14 01:00:00' },
    });
    const response = await balanceQueriesHandler.create(request(db, {
      phone_iccid: phone.iccid,
      profile_id: profile.id,
    }));

    expect(response.status).toBe(429);
    expect(db.batches).toHaveLength(0);
  });

  test('does not count failed or timed-out attempts against the daily limit', async () => {
    const db = dbStub();
    const response = await balanceQueriesHandler.create(request(db, {
      phone_iccid: phone.iccid,
      profile_id: profile.id,
    }));

    expect(response.status).toBe(202);
    const recentQuery = db.calls.find((call) =>
      call.operation === 'first' && call.sql.includes('FROM sim_balance_checks')
    );
    expect(recentQuery.sql).toContain("status IN ('response_received', 'parsed', 'unparsed')");
    expect(recentQuery.sql).not.toContain("status != 'failed'");
    expect(recentQuery.sql).not.toContain("'timed_out'");
  });

  test('rejects a SIM from a different carrier', async () => {
    const db = dbStub({ phoneResult: { ...phone, carrier: '联通' } });
    const response = await balanceQueriesHandler.create(request(db, {
      phone_iccid: phone.iccid,
      profile_id: profile.id,
    }));

    expect(response.status).toBe(409);
    expect(db.batches).toHaveLength(0);
  });
});

describe('GET /api/balance-checks', () => {
  test('returns grouped audit records with parsed metrics', async () => {
    const db = {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async all() {
                expect(sql).toContain('LEFT JOIN messages om');
                expect(sql).toContain('LEFT JOIN messages rm');
                expect(params).toEqual([phone.iccid, 25]);
                return {
                  results: [{
                    id: 'bal-1',
                    sim_iccid: phone.iccid,
                    status: 'parsed',
                    outbound_content: '10086',
                    response_content: '余额82.36元',
                    conversation_json: '[{"id":"msg-1","type":"received","content":"余额82.36元"}]',
                    metrics_json: '[{"metric_type":"cash_balance","value":82.36,"currency":"CNY"}]',
                  }],
                };
              },
            };
          },
        };
      },
    };
    const response = await balanceQueriesHandler.list({
      env: { DB: db },
      url: `https://example.com/api/balance-checks?phone_iccid=${phone.iccid}&limit=25`,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].metrics).toEqual([{
      metric_type: 'cash_balance',
      value: 82.36,
      currency: 'CNY',
    }]);
    expect(body.data[0].conversation).toEqual([{
      id: 'msg-1',
      type: 'received',
      content: '余额82.36元',
    }]);
    expect(body.data[0].metrics_json).toBeUndefined();
    expect(body.data[0].conversation_json).toBeUndefined();
  });
});

describe('balance reply correlation', () => {
  test('selects the newest pending check whose sender allowlist matches', async () => {
    const db = dbStub();
    db.prepare = () => ({
      bind: () => ({
        all: async () => ({
          results: [
            { id: 'newest', expected_senders: '["10010"]' },
            { id: 'matching', expected_senders: '["10086"]' },
          ],
        }),
      }),
    });

    const match = await findPendingBalanceCheck(db, {
      phone_iccid: phone.iccid,
      phone_number: '+8610086',
    });
    expect(match.id).toBe('matching');
  });

  test('moves a queued check to awaiting_response after SMS success', async () => {
    const db = dbStub();
    await updateBalanceCheckForSmsResult(db, 'msg-1', true);

    const update = db.calls.find((call) => call.operation === 'run');
    expect(update.params).toEqual(['awaiting_response', 1, 1, null, 'msg-1']);
  });

  test('queues only the allowlisted menu response as the next audited SMS', async () => {
    const db = dbStub();
    const check = {
      id: 'bal-menu',
      sim_iccid: phone.iccid,
      sim_number: phone.number,
      step_index: 0,
      destination: '10086',
      conversation_steps: profile.conversation_steps,
      parser_version: profile.parser_version,
    };

    const result = await linkBalanceReply(db, check, {
      id: 'msg-menu',
      phone_number: '10086',
      content: '0.业务查询与退订\n1.话费与AI豆\n2.最新活动',
    });

    expect(result.queued).toBe(true);
    const followUp = db.batches[0][0];
    expect(followUp.sql).toContain('INSERT INTO messages');
    expect(followUp.params[2]).toBe('1');
    expect(followUp.params[3]).toBe('10086');
    expect(followUp.params).not.toContain('2');
  });


  test('parses a final China Mobile balance and stores a typed metric', async () => {
    const db = dbStub();
    const check = {
      id: 'bal-final',
      step_index: 1,
      conversation_steps: profile.conversation_steps,
      parser_version: profile.parser_version,
    };

    await linkBalanceReply(db, check, {
      id: 'msg-final',
      phone_number: '10086',
      content: '尊敬的客户，您的账户余额为82.36元。',
    });

    expect(db.batches[0][0].params[0]).toBe('parsed');
    const metricInsert = db.batches[0][1];
    expect(metricInsert.params).toEqual([
      'bal-final', 'cash_balance', 82.36, null, 'CNY', null,
    ]);
  });

  test('parses China Telecom total balance (当前号码总余额) when present', () => {
    // The full SMS format reports both 可用余额 and 总余额; we take 总余额 (263.36)
    // as it is the canonical account total shown in the Telecom app.
    expect(parseBalanceMetrics(
      'cn-telecom-balance-v1',
      '【中国电信】尊敬的孙*客户：截止至8月18日，您的手机账户当前可用余额为86.36元，当前号码总余额为263.36元，预存费用余额为263.36元，赠送费用余额为0.00元。感谢您的使用！',
    )).toEqual([{
      metric_type: 'cash_balance',
      value: 263.36,
      unit: null,
      currency: 'CNY',
      expires_at: null,
    }]);
  });

  test('falls back to 当前可用余额 when 总余额 is absent', () => {
    expect(parseBalanceMetrics(
      'cn-telecom-balance-v1',
      '【中国电信】您的手机账户当前可用余额为86.36元。',
    )[0]?.value).toBe(86.36);
  });

  test('parses China Telecom general balance (当前号码通用余额) without treating charges as balance', () => {
    expect(parseBalanceMetrics(
      'cn-telecom-balance-v1',
      '当前号码通用余额为140.76元，本月已产生费用149.00元。',
    )[0]?.value).toBe(140.76);
  });

  test('parses China Telecom SMS with only 总余额 and no 可用余额', () => {
    expect(parseBalanceMetrics(
      'cn-telecom-balance-v1',
      '当前号码总余额为263.36元，预存费用余额为263.36元。',
    )[0]?.value).toBe(263.36);
  });

  test('queues the discovered 101 command from the second-level menu', async () => {
    const db = dbStub();
    const check = {
      id: 'bal-submenu',
      sim_iccid: phone.iccid,
      sim_number: phone.number,
      step_index: 1,
      destination: '10086',
      conversation_steps: profile.conversation_steps,
      parser_version: profile.parser_version,
    };

    const result = await linkBalanceReply(db, check, {
      id: 'msg-submenu',
      phone_number: '10086',
      content: '101.查询余额\n102.查询实时话费\n106.话费账单',
    });

    expect(result.queued).toBe(true);
    const followUp = db.batches[0][0];
    expect(followUp.params[2]).toBe('101');
    expect(followUp.params).not.toContain('102');
  });

  test('creates a runtime skill job when fixed rules cannot resolve a menu', async () => {
    const db = dbStub();
    const check = {
      id: 'bal-runtime-skill',
      sim_iccid: phone.iccid,
      sim_number: phone.number,
      step_index: 0,
      destination: '10086',
      conversation_steps: profile.conversation_steps,
      parser_version: profile.parser_version,
      skill_config: JSON.stringify({
        id: 'readonly-balance-menu',
        version: '1',
        objective: '查询当前可用现金话费余额',
        max_turns: 4,
        allowed_currencies: ['CNY'],
      }),
    };

    await linkBalanceReply(db, check, {
      id: 'msg-unfamiliar-menu',
      phone_number: '10086',
      content: '11.账务查询\n12.客户服务',
    });

    expect(db.batches[0][0].params[0]).toBe('response_received');
    const jobInsert = db.batches[0].find((statement) =>
      statement.sql.includes('INSERT OR IGNORE INTO sim_balance_skill_jobs')
    );
    expect(jobInsert).toBeDefined();
    expect(jobInsert.params.slice(1)).toEqual([
      'msg-unfamiliar-menu', 'bal-runtime-skill', 'msg-unfamiliar-menu',
    ]);
  });

  test('does not parse current charges as cash balance', () => {
    expect(parseBalanceMetrics(
      'cn-mobile-balance-v1',
      '本月已产生话费25.60元，当前欠费0元。',
    )).toEqual([]);
  });
});

describe('POST /api/control/balance-checks/continue', () => {
  test('continues an existing menu-stage check without creating a new check', async () => {
    const existing = {
      id: 'bal-existing',
      sim_iccid: phone.iccid,
      sim_number: phone.number,
      status: 'response_received',
      step_index: 0,
      response_message_id: 'msg-menu',
      response_sender: '10086',
      raw_response: '1.话费与AI豆',
      destination: '10086',
      conversation_steps: profile.conversation_steps,
      parser_version: profile.parser_version,
    };
    const db = dbStub({ recent: existing });
    const response = await balanceQueriesHandler.continue(request(db, {
      check_id: existing.id,
    }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.check.id).toBe(existing.id);
    expect(body.check.step_index).toBe(1);
    expect(db.batches).toHaveLength(1);
  });

  test('rejects a reply that has no configured next step', async () => {
    const db = dbStub({
      recent: {
        id: 'bal-other',
        status: 'response_received',
        step_index: 0,
        raw_response: '欢迎使用中国移动',
        conversation_steps: profile.conversation_steps,
      },
    });
    const response = await balanceQueriesHandler.continue(request(db, {
      check_id: 'bal-other',
    }));

    expect(response.status).toBe(409);
    expect(db.batches).toHaveLength(0);
  });
});

describe('POST /api/control/balance-checks/retry', () => {
  test('requeues only the last failed allowlisted maintenance step', async () => {
    const failed = {
      id: 'bal-failed',
      status: 'failed',
      step_index: 1,
      destination: '10086',
      conversation_steps: profile.conversation_steps,
      message_id: 'msg-option-1',
      message_content: '1',
      message_recipient: '10086',
      message_status: 'failed',
    };
    const db = dbStub({ recent: failed });
    const response = await balanceQueriesHandler.retry(request(db, {
      check_id: failed.id,
    }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.check.outbound_message_id).toBe('msg-option-1');
    expect(db.batches[0][0].sql).toContain("SET status = 'sending'");
    expect(db.batches[0][1].sql).toContain("SET status = 'queued'");
  });

  test('rejects a failed message whose content differs from the configured step', async () => {
    const db = dbStub({
      recent: {
        id: 'bal-tampered',
        status: 'failed',
        step_index: 1,
        destination: '10086',
        conversation_steps: profile.conversation_steps,
        message_id: 'msg-other',
        message_content: '2',
        message_recipient: '10086',
        message_status: 'failed',
      },
    });
    const response = await balanceQueriesHandler.retry(request(db, {
      check_id: 'bal-tampered',
    }));

    expect(response.status).toBe(409);
    expect(db.batches).toHaveLength(0);
  });
});

describe('POST /api/control/balance-checks/stop', () => {
  test('terminalizes an awaiting reply as timed out', async () => {
    const db = dbStub({ recent: { id: 'bal-waiting', status: 'awaiting_response' } });
    const response = await balanceQueriesHandler.stop(request(db, {
      check_id: 'bal-waiting',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.check).toEqual({ id: 'bal-waiting', status: 'timed_out' });
    expect(db.batches[0][0].params).toEqual([
      'timed_out', 'timed_out', 'bal-waiting', 'awaiting_response',
    ]);
  });

  test('terminalizes an unresolved received reply as unparsed', async () => {
    const db = dbStub({ recent: { id: 'bal-unresolved', status: 'response_received' } });
    const response = await balanceQueriesHandler.stop(request(db, {
      check_id: 'bal-unresolved',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.check).toEqual({ id: 'bal-unresolved', status: 'unparsed' });
  });
});
