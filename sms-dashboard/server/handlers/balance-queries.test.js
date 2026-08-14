import { describe, expect, test } from 'bun:test';
import {
  balanceQueriesHandler,
  carrierMatchesProfile,
  expectedSenderMatches,
  findPendingBalanceCheck,
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
  parser_version: 'cn-mobile-menu-v1',
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
});
