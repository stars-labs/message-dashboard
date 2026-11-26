import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema } from '../../test/schema.js';
import { memoryKv } from '../../test/memory-kv.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Statement } from '../lib/d1.js';
import { runAlertChecks, type AlertEmail } from './alerts.js';

const RECIPIENTS = ['ops-a@example.com', 'ops-b@example.com'];
const START = Date.parse('2026-11-25T08:00:00Z');
const MINUTE = 60_000;

let sqlite: Database;
let sent: AlertEmail[];
let kv: ReturnType<typeof memoryKv>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createSchema(sqlite);
  sent = [];
  kv = memoryKv();
  spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  sqlite.close();
});

function sqlTime(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace('T', ' ');
}

function heartbeatAt(at: number): void {
  sqlite
    .query(
      `INSERT INTO daemon_health (daemon_id, last_heartbeat) VALUES ('orange-pi-main', ?)
       ON CONFLICT (daemon_id) DO UPDATE SET last_heartbeat = excluded.last_heartbeat`,
    )
    .run(sqlTime(at));
}

function insertOfflineSim(index: number): void {
  const iccid = `8965000000000000${String(index).padStart(3, '0')}`;
  const imei = `imei-${String(index)}`;
  sqlite
    .query(
      `INSERT INTO sims (iccid, sim_index, phone_number, carrier, country_code, imei)
       VALUES (?, ?, ?, 'Singtel', 'SG', ?)`,
    )
    .run(iccid, index, `+6580000${String(index).padStart(3, '0')}`, imei);
  sqlite
    .query(
      `INSERT INTO modems (equipment_id, status, detected_iccid) VALUES (?, 'disconnected', ?)`,
    )
    .run(imei, iccid);
}

function alertRows(): unknown[] {
  return sqlite.query('SELECT alert, notified_at IS NOT NULL AS notified FROM alert_state').all();
}

const WRITE_QUOTA =
  "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

function refusingWrites(db: D1<'first' | 'run'>): D1<'first' | 'run'> {
  const refuse = (statement: D1Statement<'first' | 'run'>): D1Statement<'first' | 'run'> => ({
    first: () => statement.first(),
    run: () => Promise.reject(new Error(WRITE_QUOTA)),
    bind: (...values) => refuse(statement.bind(...values)),
  });
  return {
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) ? refuse(statement) : statement;
    },
  };
}

async function run(
  at: number,
  recipients: string[] = RECIPIENTS,
  db: D1<'first' | 'run'> = sqliteD1(sqlite),
) {
  await runAlertChecks({
    db,
    kv,
    mail: { send: (email) => Promise.resolve(void sent.push(email)) },
    recipients,
    now: at,
  });
}

describe('daemon heartbeat alert', () => {
  test('stays quiet while the last heartbeat is under 20 minutes old', async () => {
    heartbeatAt(START);

    await run(START + 19 * MINUTE);

    expect(sent).toEqual([]);
    expect(alertRows()).toEqual([]);
  });

  test('stays quiet when the daemon has never reported', async () => {
    await run(START);

    expect(sent).toEqual([]);
  });

  test('emails once after 20 minutes of silence, reminds every 6 hours, and reports recovery', async () => {
    heartbeatAt(START);

    await run(START + 21 * MINUTE);
    await run(START + 26 * MINUTE);
    expect(sent.map((email) => email.subject)).toEqual(['[SMS 告警] 采集服务 21 分钟没有心跳']);
    expect(sent[0]?.to).toEqual(RECIPIENTS);
    expect(sent[0]?.from.email).toBe('noreply@alerts.itoken.world');

    await run(START + (21 + 6 * 60) * MINUTE);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toBe('[SMS 告警] 采集服务 381 分钟没有心跳');

    heartbeatAt(START + 390 * MINUTE);
    await run(START + 391 * MINUTE);
    expect(sent[2]?.subject).toBe('[SMS 恢复] 采集服务已恢复心跳');
    expect(alertRows()).toEqual([]);
  });
});

describe('offline SIMs', () => {
  test('never email, however long they stay offline', async () => {
    heartbeatAt(START + 90 * MINUTE);
    insertOfflineSim(66);
    insertOfflineSim(67);

    for (let quarter = 0; quarter <= 4; quarter++) await run(START + quarter * 15 * MINUTE);

    expect(sent).toEqual([]);
    expect(alertRows()).toEqual([]);
  });
});

describe('delivery', () => {
  test('holds an alert as unsent while no recipients are configured, then sends it', async () => {
    heartbeatAt(START);

    await run(START + 21 * MINUTE, []);
    expect(sent).toEqual([]);
    expect(alertRows()).toEqual([{ alert: 'daemon_offline', notified: 0 }]);

    await run(START + 26 * MINUTE);
    expect(sent.map((email) => email.subject)).toEqual(['[SMS 告警] 采集服务 26 分钟没有心跳']);
  });

  test('emails a failed check once per 6 hours, even when D1 itself is down', async () => {
    const broken = {
      prepare: () => {
        throw new Error('D1_ERROR: exceeded daily row read limit');
      },
    };
    const attempt = () =>
      runAlertChecks({
        db: broken,
        kv,
        mail: { send: (email) => Promise.resolve(void sent.push(email)) },
        recipients: RECIPIENTS,
        now: START,
      });

    await attempt();
    await attempt();

    expect(sent.map((email) => email.subject)).toEqual(['[SMS 告警] 告警检查失败']);
    expect(sent[0]?.text).toContain('exceeded daily row read limit');
  });

  test('when D1 refuses writes, emails the quota once instead of a silent daemon every run', async () => {
    heartbeatAt(START);
    const db = refusingWrites(sqliteD1(sqlite));

    for (let check = 0; check < 4; check++)
      await run(START + (25 + 5 * check) * MINUTE, RECIPIENTS, db);

    expect(sent.map((email) => email.subject)).toEqual(['[SMS 告警] D1 写入额度已用完']);
    expect(sent[0]?.text).toContain('采集服务可能仍在运行');
    expect(sent[0]?.text).toContain('2026-11-26 00:00 UTC');
  });

  test('reports the silent daemon once D1 accepts writes again', async () => {
    heartbeatAt(START);
    await run(START + 25 * MINUTE, RECIPIENTS, refusingWrites(sqliteD1(sqlite)));

    await run(START + 30 * MINUTE);

    expect(sent.map((email) => email.subject)).toEqual([
      '[SMS 告警] D1 写入额度已用完',
      '[SMS 告警] 采集服务 30 分钟没有心跳',
    ]);
    expect(alertRows()).toEqual([{ alert: 'daemon_offline', notified: 1 }]);
  });
});
