import { describe, expect, test } from 'bun:test';
import { healthHandler } from './health.js';

const QUOTA_ERROR = "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

function dbStub({ row = null, error = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        async first() {
          if (error) throw error;
          return row;
        },
      };
    },
  };
}

function request(db) {
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

describe('Worker health monitoring', () => {
  test('liveness does not touch D1', async () => {
    const db = dbStub({ error: new Error('D1 must not be called') });

    const response = await healthHandler.live(request(db));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('alive');
    expect(db.calls).toHaveLength(0);
  });

  test('readiness uses one real daemon_health lookup instead of SELECT 1', async () => {
    const db = dbStub({
      row: {
        daemon_id: 'orange-pi-main',
        last_heartbeat: '2026-09-02 07:00:00',
        seconds_since_heartbeat: 3,
        metadata: daemonSnapshot(),
      },
    });

    const response = await healthHandler.check(request(db));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.database).toEqual({ status: 'connected' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]).toContain("FROM daemon_health");
    expect(db.calls[0]).toContain("WHERE daemon_id = 'orange-pi-main'");
    expect(db.calls[0]).not.toContain('SELECT 1');
  });

  test('readiness exposes a bounded quota error and midnight UTC retry time', async () => {
    const db = dbStub({ error: new Error(QUOTA_ERROR) });

    const response = await healthHandler.check(request(db));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unavailable');
    expect(body.database).toEqual({
      status: 'unavailable',
      code: 'D1_QUOTA_EXCEEDED',
      quota: 'rows_read',
      retry_at: expect.any(String),
    });
    expect(body).not.toHaveProperty('error');
    expect(response.headers.get('Retry-After')).toBe(new Date(body.database.retry_at).toUTCString());
    expect(new Date(body.database.retry_at).getUTCHours()).toBe(0);
  });

  test('readiness classifies other D1 failures without exposing raw errors', async () => {
    const db = dbStub({ error: new Error('internal database address') });

    const response = await healthHandler.check(request(db));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.database).toEqual({
      status: 'unavailable',
      code: 'D1_UNAVAILABLE',
    });
    expect(JSON.stringify(body)).not.toContain('internal database address');
  });

  test('daemon status uses the same stable D1 error contract', async () => {
    const db = dbStub({ error: new Error(QUOTA_ERROR) });

    const response = await healthHandler.daemonStatus(request(db));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('error');
    expect(body.code).toBe('D1_QUOTA_EXCEEDED');
    expect(body.message).toBe('Service status is temporarily unavailable');
    expect(JSON.stringify(body)).not.toContain('free tier daily row read limit');
  });

  test('daemon status still returns readable state when the daemon is offline', async () => {
    const db = dbStub({
      row: {
        daemon_id: 'orange-pi-main',
        last_heartbeat: '2026-09-02 06:00:00',
        seconds_since_heartbeat: 301,
        metadata: daemonSnapshot(),
      },
    });

    const response = await healthHandler.daemonStatus(request(db));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('offline');
  });

  test('daemon status exposes only the v3 snapshot instead of legacy placeholders', async () => {
    const db = dbStub({
      row: {
        daemon_id: 'orange-pi-main',
        last_heartbeat: '2026-09-02 07:00:00',
        seconds_since_heartbeat: 3,
        metadata: daemonSnapshot(),
      },
    });

    const response = await healthHandler.daemonStatus(request(db));
    const body = await response.json();

    expect(body.snapshot.queue).toEqual({
      pending: 0,
      in_flight: 0,
      dead_letter: 0,
      oldest_unacknowledged_age_seconds: null,
    });
    expect(body.snapshot.last_message_read_success_age_seconds).toBe(5);
    expect(body.snapshot.last_upload_success_age_seconds).toBe(5);
    expect(body).not.toHaveProperty('tasks');
    expect(body).not.toHaveProperty('modems');
    expect(body).not.toHaveProperty('modem_count');
    expect(body).not.toHaveProperty('queue');
  });
});
