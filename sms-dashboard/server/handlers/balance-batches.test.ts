import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { BalanceBatch } from '../../shared/api/balance-batches.js';
import { memoryKv } from '../../test/memory-kv.js';
import { createSchema } from '../../test/schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { callWorker } from '../../test/worker-harness.js';

const ADMIN = 'session-admin';
const VIEWER = 'session-viewer';
const SESSIONS = memoryKv({
  [ADMIN]: JSON.stringify({
    user: { id: 'auth0|operator', email: 'operator@example.com', roles: ['sms-admin'] },
    expires_at: Date.now() + 3_600_000,
  }),
  [VIEWER]: JSON.stringify({
    user: { id: 'auth0|viewer', email: 'viewer@example.com', roles: ['sms-viewer'] },
    expires_at: Date.now() + 3_600_000,
  }),
});

const SMS_SIMS = ['sms-1', 'sms-2'];
const WEB_SIMS = ['web-1', 'web-2'];

let sqlite: Database;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createSchema(sqlite);
  sqlite.run(`
    UPDATE sim_balance_profiles
    SET enabled = 1, discovery_enabled = 0, skill_config = '{}', conversation_steps = '[]'
    WHERE id = 'cn-mobile-sms-menu-v1';
    UPDATE sim_balance_profiles SET enabled = 1, discovery_enabled = 0
    WHERE id = 'sg-m1-prepaid-browser-v1';
  `);
  [...SMS_SIMS, ...WEB_SIMS].forEach((iccid, index) => {
    const web = iccid.startsWith('web');
    sqlite
      .query(
        `INSERT INTO sims (
           iccid, sim_index, phone_number, carrier, country_code, imei, service_type,
           service_type_source, service_type_verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'carrier_account', CURRENT_TIMESTAMP)`,
      )
      .run(
        iccid,
        index + 1,
        `+6580000${String(index + 1).padStart(3, '0')}`,
        web ? 'M1' : '移动',
        web ? 'SG' : 'CN',
        `imei-${iccid}`,
        'prepaid',
      );
    sqlite
      .query(`INSERT INTO modems (equipment_id, status, detected_iccid) VALUES (?, 'connected', ?)`)
      .run(`imei-${iccid}`, iccid);
  });
});

afterEach(() => {
  sqlite.close();
});

async function call(
  method: string,
  path: string,
  { token = ADMIN, body }: { token?: string; body?: unknown } = {},
) {
  const { response } = await callWorker(method, path, {
    headers: {
      Cookie: `auth_token=${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    bindings: { DB: sqliteD1(sqlite), SESSIONS },
  });
  return response;
}

const Queued = v.object({
  batch_id: v.string(),
  checks: v.array(v.looseObject({ id: v.string(), sim_iccid: v.string() })),
});
const BatchBody = v.object({ success: v.literal(true), batch: BalanceBatch });
const CancelBody = v.object({
  success: v.literal(true),
  cancelled: v.number(),
  batch: BalanceBatch,
});
const ListBody = v.object({ success: v.literal(true), batches: v.array(BalanceBatch) });

async function queueBatch() {
  const response = await call('POST', '/api/balance-checks/query-batch', {
    body: { methods: ['direct_sms', 'browser'], phone_iccids: [...SMS_SIMS, ...WEB_SIMS] },
  });
  expect(response.status).toBe(202);
  const body = v.parse(Queued, await response.json());
  const checkOf = (iccid: string) => {
    const check = body.checks.find((row) => row.sim_iccid === iccid);
    if (check === undefined) throw new Error(`${iccid} was not queued`);
    return check.id;
  };
  return { batchId: body.batch_id, checkOf };
}

function checkStatuses(): Record<string, string> {
  const rows = v.parse(
    v.array(v.object({ sim_iccid: v.string(), status: v.string() })),
    sqlite.query('SELECT sim_iccid, status FROM sim_balance_checks ORDER BY sim_iccid').all(),
  );
  return Object.fromEntries(rows.map(({ sim_iccid, status }) => [sim_iccid, status]));
}

describe('balance batches', () => {
  test('a batch query is saved, with every check it queued', async () => {
    const { batchId } = await queueBatch();

    expect(sqlite.query('SELECT id, requested_by_subject FROM sim_balance_batches').all()).toEqual([
      { id: batchId, requested_by_subject: 'auth0|operator' },
    ]);
    expect(
      sqlite.query('SELECT COUNT(*) AS n FROM sim_balance_checks WHERE batch_id = ?').get(batchId),
    ).toEqual({ n: 4 });
  });

  test('reports how far the batch has got', async () => {
    const { batchId, checkOf } = await queueBatch();
    sqlite.run(`UPDATE sim_balance_checks SET status = 'parsed' WHERE id = '${checkOf('sms-1')}'`);
    sqlite.run(
      `UPDATE sim_balance_checks SET status = 'timed_out' WHERE id = '${checkOf('web-1')}'`,
    );

    const response = await call('GET', `/api/balance-batches/${batchId}`, { token: VIEWER });

    expect(response.status).toBe(200);
    expect(v.parse(BatchBody, await response.json()).batch).toMatchObject({
      id: batchId,
      requested_by_subject: 'auth0|operator',
      cancelled_at: null,
      total: 4,
      parsed: 1,
      failed: 1,
      cancelled: 0,
      in_progress: 2,
      cancellable: 2,
    });
  });

  test('cancels only the checks no runner or daemon has started', async () => {
    const { batchId, checkOf } = await queueBatch();
    // sms-2's message is with the daemon; web-2's job is with a runner.
    sqlite.run(
      `UPDATE messages SET status = 'processing', processing_session_id = 's'
       WHERE balance_check_id = '${checkOf('sms-2')}'`,
    );
    sqlite.run(
      `UPDATE sim_balance_web_jobs SET status = 'leased', lease_owner = 'runner-1',
         lease_expires_at = datetime('now', '+2 minutes')
       WHERE check_id = '${checkOf('web-2')}'`,
    );

    const response = await call('POST', `/api/balance-batches/${batchId}/cancel`);

    expect(response.status).toBe(200);
    const body = v.parse(CancelBody, await response.json());
    expect(body.cancelled).toBe(2);
    expect(body.batch).toMatchObject({ cancelled: 2, in_progress: 2, cancellable: 0 });
    expect(body.batch.cancelled_at).not.toBeNull();
    expect(checkStatuses()).toEqual({
      'sms-1': 'cancelled',
      'sms-2': 'queued',
      'web-1': 'cancelled',
      'web-2': 'queued',
    });
    expect(
      sqlite
        .query(
          `SELECT c.sim_iccid, m.status FROM messages m
           JOIN sim_balance_checks c ON c.id = m.balance_check_id ORDER BY c.sim_iccid`,
        )
        .all(),
    ).toEqual([
      { sim_iccid: 'sms-1', status: 'cancelled' },
      { sim_iccid: 'sms-2', status: 'processing' },
    ]);
    expect(
      sqlite
        .query(
          `SELECT c.sim_iccid, j.status FROM sim_balance_web_jobs j
           JOIN sim_balance_checks c ON c.id = j.check_id ORDER BY c.sim_iccid`,
        )
        .all(),
    ).toEqual([
      { sim_iccid: 'web-1', status: 'stopped' },
      { sim_iccid: 'web-2', status: 'leased' },
    ]);
  });

  test('keeps the first cancellation when cancelled again', async () => {
    const { batchId } = await queueBatch();
    const first = v.parse(
      CancelBody,
      await (await call('POST', `/api/balance-batches/${batchId}/cancel`)).json(),
    );

    const again = v.parse(
      CancelBody,
      await (await call('POST', `/api/balance-batches/${batchId}/cancel`)).json(),
    );

    expect(again.cancelled).toBe(0);
    expect(again.batch.cancelled_at).toBe(first.batch.cancelled_at);
    expect(again.batch.cancelled).toBe(4);
  });

  test('frees a cancelled SIM for a new query', async () => {
    const { batchId } = await queueBatch();
    await call('POST', `/api/balance-batches/${batchId}/cancel`);

    const response = await call('POST', '/api/balance-checks/query', {
      body: { phone_iccid: 'sms-1' },
    });

    expect(response.status).toBe(202);
  });

  test('lists recent batches, newest first', async () => {
    const first = await queueBatch();
    await call('POST', `/api/balance-batches/${first.batchId}/cancel`);
    sqlite.run(`UPDATE sim_balance_batches SET created_at = datetime('now', '-1 hour')`);
    const second = await queueBatch();

    const response = await call('GET', '/api/balance-batches', { token: VIEWER });

    expect(response.status).toBe(200);
    const { batches } = v.parse(ListBody, await response.json());
    expect(batches.map(({ id, total, cancelled }) => ({ id, total, cancelled }))).toEqual([
      { id: second.batchId, total: 4, cancelled: 0 },
      { id: first.batchId, total: 4, cancelled: 4 },
    ]);
  });

  test('answers 404 for an unknown batch', async () => {
    expect((await call('GET', '/api/balance-batches/nope')).status).toBe(404);
    expect((await call('POST', '/api/balance-batches/nope/cancel')).status).toBe(404);
  });

  test('does not let a viewer cancel', async () => {
    const { batchId } = await queueBatch();

    const response = await call('POST', `/api/balance-batches/${batchId}/cancel`, {
      token: VIEWER,
    });

    expect(response.status).toBe(403);
    expect(Object.values(checkStatuses())).toEqual(['queued', 'queued', 'queued', 'queued']);
  });
});
