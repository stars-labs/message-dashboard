import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { scheduleAuthAudit, writeAuditLog } from './audit-log.js';

const AuditRow = v.object({
  action: v.string(),
  resource_type: v.nullable(v.string()),
  resource_id: v.nullable(v.string()),
  user_email: v.nullable(v.string()),
  details: v.nullable(v.string()),
  timestamp: v.nullable(v.string()),
});

function auditDatabase() {
  const d1 = sqliteD1();
  d1.db.run(`CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    user_email TEXT,
    details TEXT,
    timestamp DATETIME
  )`);
  return d1;
}

function rows(d1: ReturnType<typeof auditDatabase>) {
  return v.parse(
    v.array(AuditRow),
    d1.db
      .query(
        'SELECT action, resource_type, resource_id, user_email, details, timestamp FROM audit_logs ORDER BY id',
      )
      .all(),
  );
}

describe('writeAuditLog', () => {
  test('writes the event with its details serialized and a database timestamp', async () => {
    const d1 = auditDatabase();

    await writeAuditLog(
      { DB: d1 },
      {
        action: 'role_changed',
        resourceType: 'user',
        resourceId: 'auth0|1',
        userEmail: 'admin@example.com',
        details: { from: ['viewer'], to: 'admin' },
      },
    );

    const [row, ...rest] = rows(d1);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      action: 'role_changed',
      resource_type: 'user',
      resource_id: 'auth0|1',
      user_email: 'admin@example.com',
      details: '{"from":["viewer"],"to":"admin"}',
    });
    expect(row?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('defaults the resource type to user, the email to null and the details to an empty object', async () => {
    const d1 = auditDatabase();

    await writeAuditLog({ DB: d1 }, { action: 'login', resourceId: null });

    expect(rows(d1)).toMatchObject([
      {
        action: 'login',
        resource_type: 'user',
        resource_id: null,
        user_email: null,
        details: '{}',
      },
    ]);
  });
});

describe('scheduleAuthAudit', () => {
  afterEach(() => {
    spyOn(console, 'error').mockRestore();
  });

  test('hands the write to waitUntil and records the event', async () => {
    const d1 = auditDatabase();
    const pending: Promise<unknown>[] = [];

    scheduleAuthAudit(
      {
        env: { DB: d1 },
        ctx: {
          waitUntil: (promise) => {
            pending.push(promise);
          },
        },
      },
      { action: 'login', resourceId: 'auth0|1', userEmail: 'a@example.com' },
    );
    await Promise.all(pending);

    expect(pending).toHaveLength(1);
    expect(rows(d1)).toMatchObject([{ action: 'login', user_email: 'a@example.com' }]);
  });

  test('contains a failed write and logs its classification', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const pending: Promise<unknown>[] = [];
    const failing = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          run: () =>
            Promise.reject(new Error("D1_ERROR: exceeded D1's free tier daily row write limit")),
        };
        return statement;
      },
    };

    scheduleAuthAudit(
      {
        env: { DB: failing },
        ctx: {
          waitUntil: (promise) => {
            pending.push(promise);
          },
        },
      },
      { action: 'login_denied', resourceId: 'auth0|1' },
    );
    await Promise.all(pending);

    expect(error).toHaveBeenCalledTimes(1);
    const parsed = parseJson(
      String(error.mock.calls[0]?.[0]),
      v.object({
        event: v.string(),
        action: v.string(),
        error_code: v.string(),
        quota: v.nullable(v.string()),
        retry_at: v.nullable(v.string()),
        error: v.string(),
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const logged = parsed.value;
    expect(logged).toMatchObject({
      event: 'auth_audit_failed',
      action: 'login_denied',
      error_code: 'D1_QUOTA_EXCEEDED',
      quota: 'rows_written',
    });
    expect(logged.retry_at).not.toBeNull();
  });
});
