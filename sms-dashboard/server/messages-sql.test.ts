// GET /api/messages is the dashboard's heaviest D1 read: it ran the account
// over its daily row-read quota in 2026-09. These tests pin the statements each
// kind of request runs, with their parameters, and the indexes they use, so a
// change to how the route reads its query cannot quietly change what D1 reads.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { D1, D1Batch, D1Statement } from './lib/d1.js';
import { createControlSchema } from '../test/control-schema.js';
import { memoryKv } from '../test/memory-kv.js';
import { planDetails } from '../test/query-plan.js';
import { sqliteD1 } from '../test/sqlite-d1.js';
import { callWorker } from '../test/worker-harness.js';

const VIEWER = 'session-viewer';
const SESSIONS = memoryKv({
  [VIEWER]: JSON.stringify({
    user: { id: 'auth0|viewer', email: 'someone@example.test', roles: ['sms-viewer'] },
    expires_at: Date.now() + 3_600_000,
  }),
});

interface Executed {
  sql: string;
  params: unknown[];
}

/** `d1`, recording each statement it executes and the parameters bound to it. */
function recording(d1: D1 & D1Batch): { db: D1 & D1Batch; executed: Executed[] } {
  const executed: Executed[] = [];
  const wrap = (sql: string, statement: D1Statement, params: unknown[]): D1Statement => ({
    bind: (...values) => wrap(sql, statement.bind(...values), values),
    all: () => {
      executed.push({ sql: sql.replaceAll(/\s+/g, ' ').trim(), params });
      return statement.all();
    },
    first: () => {
      executed.push({ sql: sql.replaceAll(/\s+/g, ' ').trim(), params });
      return statement.first();
    },
    run: () => {
      executed.push({ sql: sql.replaceAll(/\s+/g, ' ').trim(), params });
      return statement.run();
    },
  });
  return {
    db: { ...d1, prepare: (sql) => wrap(sql, d1.prepare(sql), []) },
    executed,
  };
}

let sqlite: Database;

beforeEach(async () => {
  setSystemTime(new Date('2026-11-15T00:00:00.000Z'));
  sqlite = new Database(':memory:');
  await createControlSchema(sqlite);
  for (const migration of [
    '074_optimize_message_inbox_reads',
    '079_index_outbound_status_refresh',
  ]) {
    sqlite.run(await Bun.file(new URL(`../migrations/${migration}.sql`, import.meta.url)).text());
  }
  // One message every request below returns, so the statements that enrich a
  // page with its SIM run too.
  sqlite.run(
    `INSERT INTO messages (id, phone_iccid, content, type, filter_status, timestamp, created_at)
     VALUES ('m-1', '89860123456789012345', 'code 123456', 'received', 'clean',
       '2026-11-14 23:59:10', '2026-11-14 23:59:10')`,
  );
});

afterEach(() => {
  setSystemTime();
  sqlite.close();
});

function planOf({ sql, params }: Executed): string {
  return planDetails(
    sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params.map((param) => String(param))),
  ).join('\n');
}

/**
 * The statements a request ran. Each must read through an index: which one is
 * the planner's choice, and depends on statistics, but a scan of messages
 * reads its whole history.
 */
async function statementsOf(query: string): Promise<Executed[]> {
  const { db, executed } = recording(sqliteD1(sqlite));
  const { response } = await callWorker('GET', `/api/messages?${query}`, {
    headers: { Cookie: `auth_token=${VIEWER}` },
    bindings: { DB: db, SESSIONS },
  });
  expect(response.status).toBe(200);
  const scans = executed.filter((statement) => /\bSCAN m\b/.test(planOf(statement)));
  expect(scans).toEqual([]);
  return executed;
}

describe('GET /api/messages reads', () => {
  test('a first page', async () => {
    expect(await statementsOf('limit=100')).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "clean",
            "pending",
            101,
            0,
          ],
          "sql": "SELECT m.id, m.phone_iccid, m.phone_number, m.content, m.timestamp, m.type, m.status, m.recipient, m.verification_code, m.created_at, m.updated_at, m.error_message, m.sms_id, m.filter_status, m.filter_rule_id, m.purpose, m.balance_check_id, m.processing_session_id FROM messages m WHERE m.purpose = 'user' AND m.filter_status IN (?, ?) ORDER BY m.timestamp DESC, m.id DESC LIMIT ? OFFSET ?",
        },
        {
          "params": [
            "89860123456789012345",
          ],
          "sql": "SELECT iccid, number, carrier, sim_status, sim_index, country FROM device_view WHERE iccid IN (?)",
        },
      ]
    `);
  });

  test('an incremental poll', async () => {
    expect(
      await statementsOf(
        'since=2026-11-14T23:59:00.000Z&phone_iccid=89860123456789012345&limit=100',
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "89860123456789012345",
            "2026-11-14T23:59:00.000Z",
            "2026-11-15T00:00:00.000Z",
            "clean",
            "pending",
            101,
            0,
          ],
          "sql": "SELECT m.id, m.phone_iccid, m.phone_number, m.content, m.timestamp, m.type, m.status, m.recipient, m.verification_code, m.created_at, m.updated_at, m.error_message, m.sms_id, m.filter_status, m.filter_rule_id, m.purpose, m.balance_check_id, m.processing_session_id FROM messages m WHERE m.purpose = 'user' AND m.phone_iccid = ? AND m.created_at >= datetime(?, '-2 seconds') AND m.created_at <= datetime(?) AND m.filter_status IN (?, ?) ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?",
        },
        {
          "params": [
            "2026-11-14T23:59:00.000Z",
            "2026-11-15T00:00:00.000Z",
            "89860123456789012345",
            50,
          ],
          "sql": "SELECT m.id, m.phone_iccid, m.phone_number, m.content, m.timestamp, m.type, m.status, m.recipient, m.verification_code, m.created_at, m.updated_at, m.error_message, m.sms_id, m.filter_status, m.filter_rule_id, m.purpose, m.balance_check_id, m.processing_session_id FROM messages m WHERE m.purpose = 'user' AND m.type = 'sent' AND m.updated_at IS NOT NULL AND m.updated_at >= datetime(?, '-2 seconds') AND m.updated_at <= datetime(?) AND m.phone_iccid = ? ORDER BY m.updated_at DESC LIMIT ?",
        },
        {
          "params": [
            "89860123456789012345",
          ],
          "sql": "SELECT iccid, number, carrier, sim_status, sim_index, country FROM device_view WHERE iccid IN (?)",
        },
      ]
    `);
  });

  test('the next page of an incremental poll', async () => {
    expect(
      await statementsOf(
        'since=2026-11-14T23:59:00.000Z&until=2026-11-14T23:59:30.000Z' +
          '&before_created_at=2026-11-14%2023%3A59%3A20&before_id=m-9&limit=50',
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "2026-11-14T23:59:00.000Z",
            "2026-11-14T23:59:30.000Z",
            "2026-11-14 23:59:20",
            "2026-11-14 23:59:20",
            "m-9",
            "clean",
            "pending",
            51,
            0,
          ],
          "sql": "SELECT m.id, m.phone_iccid, m.phone_number, m.content, m.timestamp, m.type, m.status, m.recipient, m.verification_code, m.created_at, m.updated_at, m.error_message, m.sms_id, m.filter_status, m.filter_rule_id, m.purpose, m.balance_check_id, m.processing_session_id FROM messages m WHERE m.purpose = 'user' AND m.created_at >= datetime(?, '-2 seconds') AND m.created_at <= datetime(?) AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?)) AND m.filter_status IN (?, ?) ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?",
        },
        {
          "params": [
            "2026-11-14T23:59:00.000Z",
            "2026-11-14T23:59:30.000Z",
            50,
          ],
          "sql": "SELECT m.id, m.phone_iccid, m.phone_number, m.content, m.timestamp, m.type, m.status, m.recipient, m.verification_code, m.created_at, m.updated_at, m.error_message, m.sms_id, m.filter_status, m.filter_rule_id, m.purpose, m.balance_check_id, m.processing_session_id FROM messages m WHERE m.purpose = 'user' AND m.type = 'sent' AND m.updated_at IS NOT NULL AND m.updated_at >= datetime(?, '-2 seconds') AND m.updated_at <= datetime(?) ORDER BY m.updated_at DESC LIMIT ?",
        },
        {
          "params": [
            "89860123456789012345",
          ],
          "sql": "SELECT iccid, number, carrier, sim_status, sim_index, country FROM device_view WHERE iccid IN (?)",
        },
      ]
    `);
  });

  test('the spam drawer', async () => {
    expect(await statementsOf('include_filtered=1&limit=20&offset=40')).toMatchInlineSnapshot(`
      [
        {
          "params": [
            21,
            40,
          ],
          "sql": "SELECT m.id, m.phone_iccid, m.phone_number, m.content, m.timestamp, m.type, m.status, m.recipient, m.verification_code, m.created_at, m.updated_at, m.error_message, m.sms_id, m.filter_status, m.filter_rule_id, m.purpose, m.balance_check_id, m.processing_session_id FROM messages m WHERE m.purpose = 'user' ORDER BY m.timestamp DESC, m.id DESC LIMIT ? OFFSET ?",
        },
      ]
    `);
  });
});
