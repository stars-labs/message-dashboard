import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  createLocalD1,
  startLocalD1,
  type LocalD1,
  type LocalStatement,
} from '../scripts/local-d1.ts';
import { RECURRING, type RecurringName } from '../shared/recurring.js';
import { callState } from '../test/call-state-fleet.js';
import { controlFixtures } from '../test/control-fixtures.js';
import { memoryKv } from '../test/memory-kv.js';
import { planDetails } from '../test/query-plan.js';
import { registerRunnerSession } from '../test/runner-session.js';
import { createSchema } from '../test/schema.js';
import { callWorker, TEST_API_KEY } from '../test/worker-harness.js';
import type { D1, D1Batch, D1RunResult, D1Statement } from './lib/d1.js';
import { runScheduled } from './scheduled.js';

// ADR 0002: the idle recurring calls together read at most a fifth of the free plan's
// 5,000,000 rows a day, counted as D1 counts them (Miniflare's local D1).
const DAILY_READ_BUDGET = 1_000_000;
const SECONDS_A_DAY = 86_400;
/** Production ran 93 modems on 2026-11-26. */
const FLEET = 100;
const HISTORY = 2000;
/** What a call may read more once HISTORY rows of finished work exist: none, give or take. */
const GROWTH_ALLOWED = HISTORY / 100;

const SINCE = new Date(Date.now() - 60_000).toISOString();

type IdleCall = { fixture: string } | { dashboard: string } | { cron: string };

/**
 * How each recurring call is made with nothing to do: a daemon or Agent call as its
 * fixture records it, a dashboard poll as the client sends it, or a cron run. A call that
 * only runs while work is in progress has none. A missing entry is a type error.
 */
const IDLE_CALL: Record<RecurringName, IdleCall | null> = {
  daemonPendingSms: { fixture: 'daemon/pending-sms.empty' },
  daemonDevices: { fixture: 'daemon/devices' },
  daemonHeartbeat: { fixture: 'daemon/heartbeat' },
  runnerSkillClaim: { fixture: 'runner/balance-skills-claim.empty' },
  runnerWebClaim: { fixture: 'runner/carrier-web-claim.empty' },
  runnerHeartbeat: { fixture: 'runner/balance-runners-heartbeat' },
  dashboardMessages: { dashboard: `/api/messages?since=${encodeURIComponent(SINCE)}&limit=100` },
  dashboardDaemonStatus: { dashboard: '/api/daemon/status' },
  dashboardRunnerStatus: { dashboard: '/api/balance-runners' },
  dashboardCallState: { dashboard: '/api/calls/state' },
  dashboardLiveCallState: null,
  dashboardBatchProgress: null,
  dashboardBalanceStatus: null,
  dashboardBalanceStatusFast: null,
  cronMaintenance: { cron: RECURRING.cronMaintenance.cron },
  cronNightly: { cron: RECURRING.cronNightly.cron },
};
const NAMES = Object.keys(IDLE_CALL).filter((key): key is RecurringName => key in RECURRING);
const IDLE_NAMES = NAMES.filter((name) => IDLE_CALL[name] !== null);

const ADMIN = 'session-admin';
const sessions = () =>
  memoryKv({
    [ADMIN]: JSON.stringify({
      user: { id: 'auth0|operator', email: 'operator@example.com', roles: ['sms-admin'] },
      expires_at: Date.now() + 3_600_000,
    }),
  });

const Meta = v.object({
  meta: v.object({ rows_read: v.number(), changes: v.number(), last_row_id: v.number() }),
});
const AllResult = v.object({ results: v.array(v.unknown()), ...Meta.entries });

interface Measured {
  rowsRead: number;
  statements: string[];
}

/** The project's D1 port over Miniflare's binding, adding up what each statement read. */
function measuring(local: LocalD1, measured: Measured): D1 & D1Batch {
  const inner = new WeakMap<D1Statement, LocalStatement>();
  const runResult = ({ meta }: v.InferOutput<typeof Meta>): D1RunResult => ({
    meta: { changes: meta.changes, last_row_id: meta.last_row_id },
  });
  const wrap = (statement: LocalStatement): D1Statement => {
    const all = async () => {
      const result = v.parse(AllResult, await statement.all());
      measured.rowsRead += result.meta.rows_read;
      return { results: result.results };
    };
    const wrapped: D1Statement = {
      bind: (...values) => wrap(statement.bind(...values)),
      all,
      first: async () => (await all()).results[0] ?? null,
      run: async () => {
        const result = v.parse(Meta, await statement.run());
        measured.rowsRead += result.meta.rows_read;
        return runResult(result);
      },
    };
    inner.set(wrapped, statement);
    return wrapped;
  };
  return {
    prepare: (sql) => {
      measured.statements.push(sql);
      return wrap(local.prepare(sql));
    },
    batch: async (statements) => {
      const originals = statements.map((statement) => {
        const original = inner.get(statement);
        if (original === undefined) throw new Error('batch got a statement it did not prepare');
        return original;
      });
      const results = v.parse(v.array(Meta), await local.batch(originals));
      measured.rowsRead += results.reduce((sum, { meta }) => sum + meta.rows_read, 0);
      return results.map(runResult);
    },
  };
}

const series = (rows: number) =>
  `WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < ${String(rows)})`;

function seedFleet(db: Database): void {
  db.run(`${series(FLEET)}
    INSERT INTO sims (iccid, sim_index, phone_number)
    SELECT printf('iccid-%03d', i), i, printf('+65800%05d', i) FROM n`);
  db.run(`${series(FLEET)}
    INSERT INTO modems (equipment_id, status, detected_iccid)
    SELECT printf('imei-%03d', i), 'connected', printf('iccid-%03d', i) FROM n`);
  registerRunnerSession(db, 'runner-1');
}

function seedHistory(db: Database): void {
  db.run(`${series(HISTORY)}
    INSERT INTO messages (
      id, phone_iccid, content, type, status, recipient, filter_status,
      timestamp, created_at, updated_at
    )
    SELECT 'sent-' || i, 'iccid-001', 'history', 'sent', 'sent', '+6580000002', 'clean',
           datetime('now', '-1 day'), datetime('now', '-1 day'), datetime('now', '-1 day')
    FROM n`);
  db.run(`${series(2 * HISTORY)}
    INSERT INTO sim_balance_checks (id, sim_iccid, profile_id, status, parser_version)
    SELECT 'check-' || i, 'iccid-001', 'cn-unicom-browser-random-password-v1', 'parsed', 'v1'
    FROM n`);
  db.run(`INSERT INTO sim_balance_skill_jobs (id, check_id, step_index, status)
    SELECT 'skill-' || id, id, 0, 'completed' FROM sim_balance_checks
    WHERE CAST(substr(id, 7) AS INTEGER) <= ${String(HISTORY)}`);
  db.run(`INSERT INTO sim_balance_web_jobs (id, check_id, provider, status)
    SELECT 'web-' || id, id, 'china_unicom', 'completed' FROM sim_balance_checks
    WHERE CAST(substr(id, 7) AS INTEGER) > ${String(HISTORY)}`);
}

function count(db: Database, table: string): number {
  return Number(db.query(`SELECT COUNT(*) FROM ${table}`).values()[0]?.[0]);
}

/** Full scans of stored tables in each statement's plan, to explain a failure. */
function scans(file: string, statements: readonly string[]): string[] {
  const plans = new Database(file, { readonly: true });
  try {
    return statements.flatMap((sql) => {
      const details = planDetails(
        plans
          .query(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...Array.from(sql.matchAll(/\?/g), () => null)),
      );
      const built = new Set(
        details.flatMap((d) => /^(?:CO-ROUTINE|MATERIALIZE) (\w+)/.exec(d)?.slice(1) ?? []),
      );
      return details
        .filter((d) => {
          const scanned = /^SCAN (\w+)/.exec(d)?.[1];
          return scanned !== undefined && scanned !== 'CONSTANT' && !built.has(scanned);
        })
        .map((d) => `${d} in ${sql.replaceAll(/\s+/g, ' ').trim().slice(0, 70)}`);
    });
  } finally {
    plans.close();
  }
}

const fixtures = new Map(controlFixtures().map(({ name, fixture }) => [name, fixture]));

async function makeIdleCalls(dir: string): Promise<Map<RecurringName, Measured>> {
  const local = await startLocalD1(dir);
  try {
    const measured = new Map<RecurringName, Measured>();
    for (const name of IDLE_NAMES) {
      const idle = IDLE_CALL[name];
      const call: Measured = { rowsRead: 0, statements: [] };
      const DB = measuring(local.db, call);
      if (idle === null) continue;
      if ('cron' in idle) {
        await runScheduled(
          { cron: idle.cron, scheduledTime: Date.now() },
          { DB, SESSIONS: sessions() },
        );
      } else if ('dashboard' in idle) {
        const { response } = await callWorker('GET', idle.dashboard, {
          headers: { Cookie: `auth_token=${ADMIN}` },
          bindings: { DB, SESSIONS: sessions(), CALL_STATE: callState(null) },
        });
        expect(response.status, name).toBe(200);
      } else {
        const fixture = fixtures.get(idle.fixture);
        if (fixture === undefined) throw new Error(`${name}: no fixture ${idle.fixture}`);
        const { method, path, body } = fixture.request;
        const { response } = await callWorker(method, path, {
          headers: {
            'X-API-Key': TEST_API_KEY,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          bindings: { DB, CALL_STATE: callState(null) },
        });
        expect(response.status, name).toBe(fixture.response.status);
      }
      measured.set(name, call);
    }
    return measured;
  } finally {
    await local.dispose();
  }
}

let dir: string;
let file: string;
let quiet: Map<RecurringName, Measured>;
let busy: Map<RecurringName, Measured>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sms-dashboard-recurring-'));
  file = await createLocalD1(dir);
  const fill = (seed: (db: Database) => void | Promise<void>) => async () => {
    const db = new Database(file);
    try {
      await seed(db);
    } finally {
      db.close();
    }
  };

  await fill(async (db) => {
    await createSchema(db);
    seedFleet(db);
    expect([count(db, 'sims'), count(db, 'modems')]).toEqual([FLEET, FLEET]);
  })();
  quiet = await makeIdleCalls(dir);

  await fill((db) => {
    seedHistory(db);
    expect(
      ['messages', 'sim_balance_skill_jobs', 'sim_balance_web_jobs'].map((t) => count(db, t)),
    ).toEqual([HISTORY, HISTORY, HISTORY]);
  })();
  busy = await makeIdleCalls(dir);
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('recurring calls', () => {
  test('every idle call is made, and only those', () => {
    expect(NAMES.filter((name) => RECURRING[name].idle)).toEqual(IDLE_NAMES);
    expect([...busy.keys()]).toEqual(IDLE_NAMES);
  });

  test("wrangler.toml's cron schedule is the registry's", () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const crons = v.parse(
      v.array(v.string()),
      JSON.parse(/^crons = (\[.*\])$/m.exec(toml)?.[1] ?? 'null'),
    );
    expect(crons.sort()).toEqual(
      Object.values(RECURRING)
        .flatMap((call) => ('cron' in call ? [call.cron] : []))
        .sort(),
    );
  });

  test(`none reads more once ${String(HISTORY)} rows of finished work exist`, () => {
    const growing = IDLE_NAMES.flatMap((name) => {
      const before = quiet.get(name)?.rowsRead ?? 0;
      const after = busy.get(name);
      if (after === undefined || after.rowsRead - before <= GROWTH_ALLOWED) return [];
      return [
        `${name}: ${String(before)} → ${String(after.rowsRead)} rows; ${scans(file, after.statements).join('; ')}`,
      ];
    });
    expect(growing).toEqual([]);
  });

  test(`together they read at most ${String(DAILY_READ_BUDGET)} rows a day`, () => {
    const daily = IDLE_NAMES.map((name) => {
      const { everySeconds, callers } = RECURRING[name];
      const rowsRead = busy.get(name)?.rowsRead ?? 0;
      return { name, rowsRead, perDay: rowsRead * callers * (SECONDS_A_DAY / everySeconds) };
    });
    const total = daily.reduce((sum, { perDay }) => sum + perDay, 0);
    expect(total, JSON.stringify(daily)).toBeLessThanOrEqual(DAILY_READ_BUDGET);
  });
});
