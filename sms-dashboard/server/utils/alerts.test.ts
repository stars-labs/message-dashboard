import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema } from '../../test/schema.js';
import { memoryKv } from '../../test/memory-kv.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
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

function insertSim(index: number, modem: 'connected' | 'disconnected' | 'no-sim' | 'none'): void {
  const iccid = `8965000000000000${String(index).padStart(3, '0')}`;
  const imei = modem === 'none' ? null : `imei-${String(index)}`;
  sqlite
    .query(
      `INSERT INTO sims (iccid, sim_index, phone_number, carrier, country_code, imei)
       VALUES (?, ?, ?, 'Singtel', 'SG', ?)`,
    )
    .run(iccid, index, `+6580000${String(index).padStart(3, '0')}`, imei);
  if (imei !== null) {
    sqlite
      .query(`INSERT INTO modems (equipment_id, status, detected_iccid) VALUES (?, ?, ?)`)
      .run(
        imei,
        modem === 'disconnected' ? 'disconnected' : 'connected',
        modem === 'no-sim' ? null : iccid,
      );
  }
}

function setModem(index: number, status: 'connected' | 'disconnected'): void {
  sqlite
    .query(`UPDATE modems SET status = ? WHERE equipment_id = ?`)
    .run(status, `imei-${String(index)}`);
}

function alertRows(): unknown[] {
  return sqlite.query('SELECT alert, notified_at IS NOT NULL AS notified FROM alert_state').all();
}

async function run(at: number, recipients: string[] = RECIPIENTS) {
  await runAlertChecks({
    db: sqliteD1(sqlite),
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

describe('SIM reconciliation alert', () => {
  beforeEach(() => {
    heartbeatAt(START + 90 * MINUTE);
    insertSim(1, 'connected');
    insertSim(12, 'disconnected');
    insertSim(40, 'no-sim');
    insertSim(77, 'none');
  });

  test('runs only on the quarter hour', async () => {
    await run(START + 5 * MINUTE);

    expect(alertRows()).toEqual([]);
  });

  test('emails the assigned SIMs that stay off for 30 minutes, then reports recovery', async () => {
    await run(START);
    expect(sent).toEqual([]);
    expect(alertRows()).toEqual([{ alert: 'sims_offline', notified: 0 }]);

    await run(START + 15 * MINUTE);
    expect(sent).toEqual([]);

    await run(START + 30 * MINUTE);
    expect(sent.map((email) => email.subject)).toEqual(['[SMS 告警] 2 张卡不在线：S12、S40']);
    expect(sent[0]?.text).toContain('S12 offline');
    expect(sent[0]?.text).toContain('S40 sim_error');
    expect(sent[0]?.text).not.toContain('S77');

    setModem(12, 'connected');
    sqlite
      .query(`UPDATE modems SET detected_iccid = '8965000000000000040' WHERE equipment_id = ?`)
      .run('imei-40');
    await run(START + 45 * MINUTE);
    expect(sent[1]?.subject).toBe('[SMS 恢复] 所有已分配的卡都已在线');
    expect(alertRows()).toEqual([]);
  });

  test('forgets a SIM outage that clears before 30 minutes, without any email', async () => {
    await run(START);
    setModem(12, 'connected');
    sqlite
      .query(`UPDATE modems SET detected_iccid = '8965000000000000040' WHERE equipment_id = ?`)
      .run('imei-40');
    await run(START + 15 * MINUTE);

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
});
