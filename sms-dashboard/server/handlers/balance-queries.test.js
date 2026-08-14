import { describe, expect, test } from 'bun:test';
import {
  balanceQueriesHandler,
  carrierMatchesProfile,
  expectedSenderMatches,
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

  test('matches only a configured service sender', () => {
    expect(expectedSenderMatches('10086', '["10086"]')).toBe(true);
    expect(expectedSenderMatches('+8610086', '["10086"]')).toBe(true);
    expect(expectedSenderMatches('10086100', '["10086"]')).toBe(false);
    expect(expectedSenderMatches('10086', 'not-json')).toBe(false);
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

  test('does not count failed pre-send attempts against the daily limit', async () => {
    const db = dbStub();
    const response = await balanceQueriesHandler.create(request(db, {
      phone_iccid: phone.iccid,
      profile_id: profile.id,
    }));

    expect(response.status).toBe(202);
    const recentQuery = db.calls.find((call) =>
      call.operation === 'first' && call.sql.includes('FROM sim_balance_checks')
    );
    expect(recentQuery.sql).toContain("status != 'failed'");
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
