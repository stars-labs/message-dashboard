import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
import { ORPCError } from '@orpc/server';
import { createSchema } from '../../test/schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Statement } from '../lib/d1.js';
import { healthHandler } from './health.js';

const QUOTA_ERROR =
  "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

function dbStub({ row = null, error }: { row?: object | null; error?: Error } = {}) {
  const calls: string[] = [];
  const statement: D1Statement<'first'> = {
    bind: () => statement,
    first: () => (error ? Promise.reject(error) : Promise.resolve(row)),
  };
  const db: D1<'first'> = {
    prepare: (sql) => {
      calls.push(sql);
      return statement;
    },
  };
  return { db, calls };
}

function daemonSnapshot() {
  return JSON.stringify({
    schema_version: 3,
    session_id: 'session',
    version: '8.0.0',
    uptime_seconds: 600,
    last_message_read_success_age_seconds: 2,
    last_upload_success_age_seconds: 2,
    queue: { pending: 0, in_flight: 0, dead_letter: 0, oldest_unacknowledged_age_seconds: null },
  });
}

function healthRow(overrides: Record<string, unknown> = {}) {
  return {
    daemon_id: 'orange-pi-main',
    last_heartbeat: '2026-09-02 07:00:00',
    seconds_since_heartbeat: 3,
    metadata: daemonSnapshot(),
    ...overrides,
  };
}

type HealthCall = Parameters<typeof healthHandler.check>[0];

interface Answer {
  status: number;
  body: unknown;
  headers: Headers;
}

/** What the contract handler answers: the value, or the error's status, code, message and members. */
async function answer(run: (call: HealthCall) => unknown, db: D1<'first'>): Promise<Answer> {
  const resHeaders = new Headers();
  try {
    return { status: 200, body: await run({ env: { DB: db }, resHeaders }), headers: resHeaders };
  } catch (error) {
    if (!(error instanceof ORPCError)) throw error;
    const members = v.parse(v.record(v.string(), v.unknown()), error.data ?? {});
    return {
      status: error.status,
      body: { code: String(error.code), message: error.message, ...members },
      headers: resHeaders,
    };
  }
}

const live = () => answer((call) => healthHandler.live(call), dbStub().db);
const check = (db: D1<'first'>) => answer((call) => healthHandler.check(call), db);
const daemonStatus = (db: D1<'first'>) => answer((call) => healthHandler.daemonStatus(call), db);

const Readiness = v.looseObject({
  status: v.string(),
  database: v.optional(v.looseObject({ retry_at: v.optional(v.string()) })),
});

/** The readiness report: the answer itself, or the `health` member of a 503. */
function readiness({ status, body }: Answer) {
  return v.parse(
    Readiness,
    status === 503 ? v.parse(v.object({ health: v.unknown() }), body).health : body,
  );
}

describe('Worker health monitoring', () => {
  test('liveness does not touch D1', async () => {
    const answered = await live();

    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ status: 'alive' });
  });

  test('readiness uses one real daemon_health lookup instead of SELECT 1', async () => {
    const { db, calls } = dbStub({ row: healthRow() });

    const answered = await check(db);
    const body = readiness(answered);

    expect(answered.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.database).toEqual({ status: 'connected' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('FROM daemon_health');
    expect(calls[0]).toContain("WHERE daemon_id = 'orange-pi-main'");
    expect(calls[0]).not.toContain('SELECT 1');
  });

  test('readiness exposes a bounded quota error and midnight UTC retry time', async () => {
    const { db } = dbStub({ error: new Error(QUOTA_ERROR) });

    const answered = await check(db);
    const body = readiness(answered);

    expect(answered.status).toBe(503);
    expect(answered.body).toMatchObject({
      code: 'NOT_HEALTHY',
      message: 'Database dependency is unavailable',
    });
    expect(body.status).toBe('unavailable');
    const retryAt = new Date(body.database?.retry_at ?? '');
    expect(body.database).toEqual({
      status: 'unavailable',
      code: 'D1_QUOTA_EXCEEDED',
      quota: 'rows_read',
      retry_at: retryAt.toISOString(),
    });
    expect(body).not.toHaveProperty('error');
    expect(answered.headers.get('Retry-After')).toBe(retryAt.toUTCString());
    expect(answered.headers.get('Cache-Control')).toBe('no-store');
    expect(retryAt.getUTCHours()).toBe(0);
  });

  test('every health answer forbids caching', async () => {
    const { db } = dbStub({ row: healthRow() });

    const answers = [
      await live(),
      await check(db),
      await check(dbStub({ error: new Error('boom') }).db),
      await daemonStatus(db),
      await daemonStatus(dbStub({ error: new Error('boom') }).db),
    ];

    expect(answers.map(({ headers }) => headers.get('Cache-Control'))).toEqual([
      'no-store',
      'no-store',
      'no-store',
      'no-store',
      'no-store',
    ]);
  });

  test('readiness classifies other D1 failures without exposing raw errors', async () => {
    const { db } = dbStub({ error: new Error('internal database address') });

    const answered = await check(db);

    expect(answered.status).toBe(503);
    expect(readiness(answered).database).toEqual({
      status: 'unavailable',
      code: 'D1_UNAVAILABLE',
    });
    expect(answered.headers.has('Retry-After')).toBe(false);
    expect(JSON.stringify(answered.body)).not.toContain('internal database address');
  });

  test('readiness reports an unknown daemon as unavailable before it first connects', async () => {
    const { db } = dbStub({ row: null });

    const answered = await check(db);

    expect(answered.status).toBe(503);
    expect(readiness(answered)).toMatchObject({
      status: 'unknown',
      database: { status: 'connected' },
      daemon: { status: 'unknown', last_heartbeat: null },
    });
  });

  test('readiness answers 503 as unavailable when the row does not match the schema', async () => {
    const { db } = dbStub({ row: healthRow({ last_heartbeat: 5 }) });

    const answered = await check(db);

    expect(answered.status).toBe(503);
    expect(readiness(answered).database).toEqual({
      status: 'unavailable',
      code: 'D1_UNAVAILABLE',
    });
  });

  test('daemon status uses the same stable D1 error contract', async () => {
    const { db } = dbStub({ error: new Error(QUOTA_ERROR) });

    const answered = await daemonStatus(db);

    expect(answered.status).toBe(503);
    expect(answered.body).toMatchObject({
      code: 'D1_QUOTA_EXCEEDED',
      quota: 'rows_read',
      message: 'Service status is temporarily unavailable',
    });
    const { timestamp } = v.parse(v.object({ timestamp: v.string() }), answered.body);
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    expect(JSON.stringify(answered.body)).not.toContain('free tier daily row read limit');
    expect(answered.headers.has('Retry-After')).toBe(true);
  });

  test('daemon status still returns readable state when the daemon is offline', async () => {
    const { db } = dbStub({
      row: healthRow({ last_heartbeat: '2026-09-02 06:00:00', seconds_since_heartbeat: 301 }),
    });

    const answered = await daemonStatus(db);

    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ status: 'offline' });
  });

  test('daemon status exposes only the v3 snapshot instead of legacy placeholders', async () => {
    const { db } = dbStub({ row: healthRow() });

    const { body } = await daemonStatus(db);

    expect(body).toMatchObject({
      daemon_id: 'orange-pi-main',
      status: 'healthy',
      message: '正常运行中',
      seconds_since_heartbeat: 3,
      snapshot: {
        queue: {
          pending: 0,
          in_flight: 0,
          dead_letter: 0,
          oldest_unacknowledged_age_seconds: null,
        },
        last_message_read_success_age_seconds: 5,
        last_upload_success_age_seconds: 5,
      },
    });
    expect(body).not.toHaveProperty('tasks');
    expect(body).not.toHaveProperty('modems');
    expect(body).not.toHaveProperty('modem_count');
    expect(body).not.toHaveProperty('queue');
  });

  test('daemon status explains a daemon that has not connected yet', async () => {
    const { db } = dbStub({ row: null });

    const answered = await daemonStatus(db);

    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      status: 'unknown',
      message: '等待采集服务首次连接',
      snapshot: null,
    });
  });

  test('daemon status answers 503 when the row does not match the schema', async () => {
    const { db } = dbStub({ row: healthRow({ daemon_id: null }) });

    const answered = await daemonStatus(db);

    expect(answered.status).toBe(503);
    expect(answered.body).toMatchObject({ code: 'D1_UNAVAILABLE' });
  });
});

describe('daemon_health lookup on SQLite', () => {
  async function databaseWith(
    rows: { id: string; heartbeatSecondsAgo: number; metadata: string | null }[],
  ) {
    const database = new Database(':memory:');
    await createSchema(database);
    const d1 = sqliteD1(database);
    for (const row of rows) {
      d1.db
        .query(
          `INSERT INTO daemon_health (daemon_id, last_heartbeat, metadata)
           VALUES (?, datetime('now', ?), ?)`,
        )
        .run(row.id, `-${String(row.heartbeatSecondsAgo)} seconds`, row.metadata);
    }
    return d1;
  }

  test('a fresh heartbeat reads healthy', async () => {
    const d1 = await databaseWith([
      { id: 'orange-pi-main', heartbeatSecondsAgo: 10, metadata: daemonSnapshot() },
    ]);

    const answered = await check(d1);

    expect(answered.status).toBe(200);
    expect(readiness(answered).status).toBe('healthy');
  });

  test('a heartbeat older than three minutes reads offline', async () => {
    const d1 = await databaseWith([
      { id: 'orange-pi-main', heartbeatSecondsAgo: 600, metadata: daemonSnapshot() },
    ]);

    const { body } = await daemonStatus(d1);

    expect(body).toMatchObject({ status: 'offline', daemon_id: 'orange-pi-main' });
  });

  test('another daemon id is ignored', async () => {
    const d1 = await databaseWith([
      { id: 'someone-else', heartbeatSecondsAgo: 1, metadata: daemonSnapshot() },
    ]);

    expect((await daemonStatus(d1)).body).toMatchObject({ status: 'unknown', snapshot: null });
  });

  test('a row without a stored snapshot reads unknown', async () => {
    const d1 = await databaseWith([
      { id: 'orange-pi-main', heartbeatSecondsAgo: 1, metadata: null },
    ]);

    expect((await daemonStatus(d1)).body).toMatchObject({
      status: 'unknown',
      message: '健康报告格式无效或缺失',
    });
  });
});
