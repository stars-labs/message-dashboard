import { describe, expect, test } from 'bun:test';
import { controlHandler, normalizeDaemonSessionId } from './control.js';

function dbStub({ pending = [] } = {}) {
  const calls = [];

  function statement(sql, params = []) {
    return {
      bind(...nextParams) {
        return statement(sql, nextParams);
      },
      async run() {
        calls.push({ operation: 'run', sql, params });
        return { meta: { changes: 1 } };
      },
      async all() {
        calls.push({ operation: 'all', sql, params });
        if (sql.includes('ROW_NUMBER() OVER')) return { results: pending };
        if (sql.includes('SELECT id, phone_iccid')) {
          return {
            results: pending.map(({ id }) => ({
              id,
              phone_iccid: 'iccid-1',
              phone_number: '+8613800138000',
              recipient: '10010',
              content: 'YE',
              purpose: 'user',
              created_at: '2026-08-14 10:00:00',
            })),
          };
        }
        return { results: [] };
      },
    };
  }

  return {
    calls,
    prepare(sql) {
      return statement(sql);
    },
  };
}

function request(db, sessionId = 'rust-daemon-session-2') {
  return {
    env: { API_KEY: 'secret', DB: db },
    headers: new Headers({
      'X-API-Key': 'secret',
      'X-Daemon-Session-Id': sessionId,
      'X-Daemon-Version': '8.1.0',
    }),
  };
}

function resultRequest(db, body) {
  return {
    env: { API_KEY: 'secret', DB: db },
    headers: new Headers({ 'X-API-Key': 'secret' }),
    json: async () => body,
  };
}

describe('outbound SMS daemon session leases', () => {
  test('accepts only bounded, inert session identifiers', () => {
    expect(normalizeDaemonSessionId('rust-daemon-abc_123')).toBe('rust-daemon-abc_123');
    expect(normalizeDaemonSessionId('bad session')).toBeNull();
    expect(normalizeDaemonSessionId("x' OR 1=1")).toBeNull();
  });

  test('marks interrupted claims unknown and tags new claims with this session', async () => {
    const db = dbStub({ pending: [{ id: 'msg-1' }] });
    const response = await controlHandler.heartbeatAndGetPendingSMS(request(db));

    expect(response.status).toBe(200);
    const recovery = db.calls.find((call) => call.sql.includes("SET status = 'unknown'"));
    expect(recovery.params).toEqual(['rust-daemon-session-2']);
    expect(recovery.sql).not.toContain("status = 'sending'");

    const claim = db.calls.find((call) => call.sql.includes("SET status = 'processing'"));
    expect(claim.params).toEqual(['rust-daemon-session-2', 'msg-1']);
  });

  test('rejects a malformed session header before touching the database', async () => {
    const db = dbStub();
    const response = await controlHandler.heartbeatAndGetPendingSMS(request(db, 'bad session'));
    expect(response.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });
});

describe('outbound SMS submission outcomes', () => {
  test('records an unconfirmed modem submission as unknown without failing its balance check', async () => {
    const db = dbStub();
    const response = await controlHandler.updateSMSResult(resultRequest(db, {
      message_id: 'msg-1',
      outcome: 'submitted_unconfirmed',
    }));

    expect(response.status).toBe(200);
    const messageUpdate = db.calls.find((call) =>
      call.operation === 'run' && call.sql.includes('SET status = ?, error_message = ?')
    );
    expect(messageUpdate.params).toEqual(['unknown', null, null, 'msg-1']);
    const balanceUpdate = db.calls.find((call) =>
      call.operation === 'run' && call.sql.includes('UPDATE sim_balance_checks')
    );
    expect(balanceUpdate.params).toEqual(['awaiting_response', 1, 1, null, 'msg-1']);
  });

  test('rejects the removed boolean success result', async () => {
    const db = dbStub();
    const response = await controlHandler.updateSMSResult(resultRequest(db, {
      message_id: 'msg-1',
      success: true,
    }));

    expect(response.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });
});
