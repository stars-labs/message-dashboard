import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as v from 'valibot';
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

function request(db: D1<'first'>) {
  return { env: { DB: db } };
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

const Body = v.looseObject({
  status: v.string(),
  database: v.optional(v.looseObject({ retry_at: v.optional(v.string()) })),
  snapshot: v.optional(v.looseObject({})),
});

async function bodyOf(response: Response) {
  return v.parse(Body, await response.json());
}

async function rawBody(response: Response): Promise<unknown> {
  return await response.json();
}

describe('Worker health monitoring', () => {
  test('liveness does not touch D1', async () => {
    const response = healthHandler.live();

    expect(response.status).toBe(200);
    expect((await bodyOf(response)).status).toBe('alive');
  });

  test('readiness uses one real daemon_health lookup instead of SELECT 1', async () => {
    const { db, calls } = dbStub({ row: healthRow() });

    const response = await healthHandler.check(request(db));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.database).toEqual({ status: 'connected' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('FROM daemon_health');
    expect(calls[0]).toContain("WHERE daemon_id = 'orange-pi-main'");
    expect(calls[0]).not.toContain('SELECT 1');
  });

  test('readiness exposes a bounded quota error and midnight UTC retry time', async () => {
    const { db } = dbStub({ error: new Error(QUOTA_ERROR) });

    const response = await healthHandler.check(request(db));
    const body = await bodyOf(response);

    expect(response.status).toBe(503);
    expect(body.status).toBe('unavailable');
    const retryAt = new Date(body.database?.retry_at ?? '');
    expect(body.database).toEqual({
      status: 'unavailable',
      code: 'D1_QUOTA_EXCEEDED',
      quota: 'rows_read',
      retry_at: retryAt.toISOString(),
    });
    expect(body).not.toHaveProperty('error');
    expect(response.headers.get('Retry-After')).toBe(retryAt.toUTCString());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(retryAt.getUTCHours()).toBe(0);
  });

  test('every health answer forbids caching', async () => {
    const { db } = dbStub({ row: healthRow() });

    const answers = [
      healthHandler.live(),
      await healthHandler.check(request(db)),
      await healthHandler.daemonStatus(request(db)),
      await healthHandler.daemonStatus(request(dbStub({ error: new Error('boom') }).db)),
    ];

    expect(answers.map((response) => response.headers.get('Cache-Control'))).toEqual([
      'no-store',
      'no-store',
      'no-store',
      'no-store',
    ]);
  });

  test('readiness classifies other D1 failures without exposing raw errors', async () => {
    const { db } = dbStub({ error: new Error('internal database address') });

    const response = await healthHandler.check(request(db));
    const body = await bodyOf(response);

    expect(response.status).toBe(503);
    expect(body.database).toEqual({
      status: 'unavailable',
      code: 'D1_UNAVAILABLE',
    });
    expect(response.headers.has('Retry-After')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('internal database address');
  });

  test('readiness reports an unknown daemon as unavailable before it first connects', async () => {
    const { db } = dbStub({ row: null });

    const response = await healthHandler.check(request(db));

    expect(response.status).toBe(503);
    expect(await rawBody(response)).toMatchObject({
      status: 'unknown',
      database: { status: 'connected' },
      daemon: { status: 'unknown', last_heartbeat: null },
    });
  });

  test('readiness answers 503 as unavailable when the row does not match the schema', async () => {
    const { db } = dbStub({ row: healthRow({ last_heartbeat: 5 }) });

    const response = await healthHandler.check(request(db));

    expect(response.status).toBe(503);
    expect((await bodyOf(response)).database).toEqual({
      status: 'unavailable',
      code: 'D1_UNAVAILABLE',
    });
  });

  test('daemon status uses the same stable D1 error contract', async () => {
    const { db } = dbStub({ error: new Error(QUOTA_ERROR) });

    const response = await healthHandler.daemonStatus(request(db));
    const body = await rawBody(response);

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'error',
      code: 'D1_QUOTA_EXCEEDED',
      message: 'Service status is temporarily unavailable',
    });
    expect(JSON.stringify(body)).not.toContain('free tier daily row read limit');
    expect(response.headers.has('Retry-After')).toBe(true);
  });

  test('daemon status still returns readable state when the daemon is offline', async () => {
    const { db } = dbStub({
      row: healthRow({ last_heartbeat: '2026-09-02 06:00:00', seconds_since_heartbeat: 301 }),
    });

    const response = await healthHandler.daemonStatus(request(db));

    expect(response.status).toBe(200);
    expect((await bodyOf(response)).status).toBe('offline');
  });

  test('daemon status exposes only the v3 snapshot instead of legacy placeholders', async () => {
    const { db } = dbStub({ row: healthRow() });

    const response = await healthHandler.daemonStatus(request(db));
    const body = await rawBody(response);

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

    const response = await healthHandler.daemonStatus(request(db));

    expect(response.status).toBe(200);
    expect(await rawBody(response)).toMatchObject({
      status: 'unknown',
      message: '等待采集服务首次连接',
      snapshot: null,
    });
  });

  test('daemon status answers 503 when the row does not match the schema', async () => {
    const { db } = dbStub({ row: healthRow({ daemon_id: null }) });

    const response = await healthHandler.daemonStatus(request(db));

    expect(response.status).toBe(503);
    expect(await rawBody(response)).toMatchObject({ status: 'error', code: 'D1_UNAVAILABLE' });
  });
});

describe('daemon_health lookup on SQLite', () => {
  function databaseWith(
    rows: { id: string; heartbeatSecondsAgo: number; metadata: string | null }[],
  ) {
    const d1 = sqliteD1();
    d1.db.run(`CREATE TABLE daemon_health (
      daemon_id TEXT PRIMARY KEY,
      last_heartbeat TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'online' CHECK(status IN ('online', 'offline', 'warning')),
      last_ip TEXT,
      version TEXT,
      modem_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
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
    const d1 = databaseWith([
      { id: 'orange-pi-main', heartbeatSecondsAgo: 10, metadata: daemonSnapshot() },
    ]);

    const response = await healthHandler.check(request(d1));

    expect(response.status).toBe(200);
    expect((await bodyOf(response)).status).toBe('healthy');
  });

  test('a heartbeat older than three minutes reads offline', async () => {
    const d1 = databaseWith([
      { id: 'orange-pi-main', heartbeatSecondsAgo: 600, metadata: daemonSnapshot() },
    ]);

    const response = await healthHandler.daemonStatus(request(d1));
    const body = await rawBody(response);

    expect(body).toMatchObject({ status: 'offline', daemon_id: 'orange-pi-main' });
  });

  test('another daemon id is ignored', async () => {
    const d1 = databaseWith([
      { id: 'someone-else', heartbeatSecondsAgo: 1, metadata: daemonSnapshot() },
    ]);

    const response = await healthHandler.daemonStatus(request(d1));

    expect(await rawBody(response)).toMatchObject({ status: 'unknown', snapshot: null });
  });

  test('a row without a stored snapshot reads unknown', async () => {
    const d1 = databaseWith([{ id: 'orange-pi-main', heartbeatSecondsAgo: 1, metadata: null }]);

    const response = await healthHandler.daemonStatus(request(d1));

    expect(await rawBody(response)).toMatchObject({
      status: 'unknown',
      message: '健康报告格式无效或缺失',
    });
  });
});
