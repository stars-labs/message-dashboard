import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { Schema } from '../../shared/parse-json.js';
import { createControlSchema } from '../../test/control-schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { controlHandler, normalizeDaemonSessionId } from './control.js';

type TestDb = D1 & D1Batch<'run'>;

const API_KEY = 'secret';
const ICCID = '898600520121F0517883';
const NUMBER = '+8613520607015';

const Row = v.record(v.string(), v.unknown());
const CountRow = v.object({ count: v.number() });
const ErrorBody = v.object({ success: v.optional(v.literal(false)), error: v.string() });

let sqlite: Database;
let db: TestDb;
let background: Promise<unknown>[];

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createControlSchema(sqlite);
  db = sqliteD1(sqlite);
  background = [];
});

afterEach(() => {
  sqlite.close();
});

const untouchable: TestDb = {
  prepare: () => {
    throw new Error('database must not be read');
  },
  batch: () => {
    throw new Error('database must not be written');
  },
};

interface RequestOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  rawBody?: string;
  database?: TestDb;
}

function controlRequest(
  body: unknown,
  { apiKey = API_KEY, headers = {}, rawBody, database = db }: RequestOptions = {},
) {
  const text = rawBody ?? JSON.stringify(body);
  return {
    env: { API_KEY, DB: database },
    headers: new Headers({ 'X-API-Key': apiKey, ...headers }),
    text: () => Promise.resolve(text),
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    },
  };
}

function one<T>(schema: Schema<T>, sql: string, ...params: (string | number | null)[]): T {
  return v.parse(schema, sqlite.query(sql).get(...params));
}

function every<T>(schema: Schema<T>, sql: string, ...params: (string | number | null)[]): T[] {
  return v.parse(v.array(schema), sqlite.query(sql).all(...params));
}

function count(sql: string, ...params: (string | number | null)[]): number {
  return one(CountRow, sql, ...params).count;
}

async function read<T>(response: Response, schema: Schema<T>): Promise<T> {
  return v.parse(schema, await response.json());
}

async function errorOf(response: Response): Promise<string> {
  return (await read(response, ErrorBody)).error;
}

describe('every control route', () => {
  test('requires the daemon API key before reading the body or touching D1', async () => {
    for (const route of [
      'updateDevices',
      'uploadMessages',
      'cleanupTestData',
      'getPendingSMS',
      'updateSMSResult',
      'clearMessages',
      'heartbeat',
    ] as const) {
      let bodyRead = false;
      const request = controlRequest({}, { apiKey: 'wrong', database: untouchable });
      const response = await controlHandler[route]({
        ...request,
        text: () => {
          bodyRead = true;
          return request.text();
        },
      });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toBe('Unauthorized');
      expect(bodyRead).toBe(false);
    }
  });

  test('answers 400 to a body that is not JSON', async () => {
    for (const route of [
      'updateDevices',
      'uploadMessages',
      'updateSMSResult',
      'cleanupTestData',
      'heartbeat',
    ] as const) {
      const response = await controlHandler[route](
        controlRequest(null, { rawBody: '{', database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('Body must be JSON');
    }
  });
});

interface ReportFields {
  equipment_id: string;
  manufacturer?: string | null;
  model?: string | null;
  firmware_revision?: string | null;
  hardware_revision?: string | null;
  detected_iccid?: string | null;
  detected_phone_number?: string | null;
  detected_operator?: string | null;
  signal_percent?: number | null;
  rssi?: number | null;
  modem_index?: number | null;
  usb_port?: number | null;
  usb_path?: string | null;
  status?: string | null;
}

function report(overrides: Partial<ReportFields> = {}): ReportFields {
  return {
    equipment_id: 'modem-a',
    manufacturer: 'Quectel',
    model: 'EC20',
    firmware_revision: '1',
    hardware_revision: '1',
    detected_iccid: 'iccid-a',
    detected_phone_number: null,
    detected_operator: 'carrier',
    signal_percent: 80,
    rssi: -70,
    modem_index: 1,
    usb_port: 1,
    usb_path: '1-1',
    status: 'active',
    ...overrides,
  };
}

function devicesBody(
  syncMode: 'incremental' | 'full' = 'incremental',
  reports: unknown[] = [report()],
  removed: unknown[] = [],
) {
  return {
    modem_reports: reports,
    removed_equipment_ids: removed,
    sync_mode: syncMode,
    session_id: 'session-1',
    timestamp: '2026-09-02T00:00:00.000Z',
  };
}

const ModemRow = v.object({
  equipment_id: v.string(),
  manufacturer: v.nullable(v.string()),
  model: v.nullable(v.string()),
  detected_iccid: v.nullable(v.string()),
  detected_operator: v.nullable(v.string()),
  signal_percent: v.nullable(v.number()),
  rssi: v.nullable(v.number()),
  usb_path: v.nullable(v.string()),
  last_usb_path: v.nullable(v.string()),
  status: v.nullable(v.string()),
  verification_status: v.nullable(v.string()),
  last_verified_session: v.nullable(v.string()),
});

const MODEM_COLUMNS = `equipment_id, manufacturer, model, detected_iccid, detected_operator,
  signal_percent, rssi, usb_path, last_usb_path, status, verification_status, last_verified_session`;

function modems() {
  return every(ModemRow, `SELECT ${MODEM_COLUMNS} FROM modems ORDER BY equipment_id`);
}

const DevicesResult = v.object({
  success: v.literal(true),
  sync_mode: v.string(),
  session_id: v.nullable(v.string()),
  processed: v.object({ modem_reports: v.number(), modems_disconnected: v.number() }),
});

async function syncDevices(body: unknown) {
  const response = await controlHandler.updateDevices(controlRequest(body));
  expect(response.status).toBe(200);
  return read(response, DevicesResult);
}

describe('POST /api/control/devices', () => {
  beforeEach(() => {
    sqlite.run(`
      CREATE TABLE modem_update_log (equipment_id TEXT NOT NULL);
      CREATE TRIGGER audit_modem_update AFTER UPDATE ON modems
      BEGIN
        INSERT INTO modem_update_log (equipment_id) VALUES (NEW.equipment_id);
      END;
    `);
  });

  function updates(): number {
    return count(`SELECT COUNT(*) AS count FROM modem_update_log`);
  }

  test('stores a new report and suppresses an unchanged one', async () => {
    expect(await syncDevices(devicesBody())).toEqual({
      success: true,
      sync_mode: 'incremental',
      session_id: 'session-1',
      processed: { modem_reports: 1, modems_disconnected: 0 },
    });
    expect(modems()).toEqual([
      {
        equipment_id: 'modem-a',
        manufacturer: 'Quectel',
        model: 'EC20',
        detected_iccid: 'iccid-a',
        detected_operator: 'carrier',
        signal_percent: 80,
        rssi: -70,
        usb_path: '1-1',
        last_usb_path: '1-1',
        status: 'active',
        verification_status: null,
        last_verified_session: null,
      },
    ]);

    await syncDevices(devicesBody());
    expect(updates()).toBe(0);

    await syncDevices(devicesBody('incremental', [report({ signal_percent: 81 })]));
    expect(updates()).toBe(1);
    expect(modems()[0]?.signal_percent).toBe(81);
  });

  test('keeps the last USB path when the modem reports none, and defaults blanks', async () => {
    await syncDevices(devicesBody());
    await syncDevices(
      devicesBody('incremental', [
        report({ usb_path: null, manufacturer: '', status: null, detected_operator: '' }),
      ]),
    );

    expect(modems()[0]).toMatchObject({
      usb_path: null,
      last_usb_path: '1-1',
      manufacturer: null,
      detected_operator: null,
      status: 'active',
    });
  });

  test('full sync verifies present modems, disconnects missing ones, then becomes write-free', async () => {
    await syncDevices(devicesBody('incremental', [report(), report({ equipment_id: 'modem-b' })]));

    const full = await syncDevices(devicesBody('full'));
    expect(full.processed).toEqual({ modem_reports: 1, modems_disconnected: 1 });
    expect(modems()).toMatchObject([
      {
        equipment_id: 'modem-a',
        verification_status: 'verified',
        last_verified_session: 'session-1',
      },
      {
        equipment_id: 'modem-b',
        status: 'disconnected',
        verification_status: 'absent',
        detected_iccid: null,
        signal_percent: null,
        usb_path: null,
        last_usb_path: '1-1',
      },
    ]);

    const before = updates();
    expect((await syncDevices(devicesBody('full'))).processed.modems_disconnected).toBe(0);
    expect(updates()).toBe(before);
  });

  test('an empty full snapshot disconnects every previously present modem', async () => {
    await syncDevices(devicesBody('incremental', [report(), report({ equipment_id: 'modem-b' })]));

    const full = await syncDevices(devicesBody('full', []));

    expect(full.processed).toEqual({ modem_reports: 0, modems_disconnected: 2 });
    expect(modems().map((modem) => modem.status)).toEqual(['disconnected', 'disconnected']);
  });

  test('marks explicitly removed modems disconnected during incremental sync', async () => {
    await syncDevices(devicesBody('incremental', [report(), report({ equipment_id: 'modem-b' })]));

    const result = await syncDevices(devicesBody('incremental', [], ['modem-b', 'modem-b']));

    expect(result.processed).toEqual({ modem_reports: 0, modems_disconnected: 1 });
    expect(modems().map((modem) => [modem.equipment_id, modem.status])).toEqual([
      ['modem-a', 'active'],
      ['modem-b', 'disconnected'],
    ]);
  });

  test('ignores reports without an id and placeholder modems without identity', async () => {
    const result = await syncDevices(
      devicesBody('incremental', [
        report({ equipment_id: '' }),
        report({ equipment_id: 'MODEM_3', manufacturer: null, model: '' }),
        report({ equipment_id: 'MODEM_4', manufacturer: 'Quectel' }),
      ]),
    );

    expect(result.processed.modem_reports).toBe(1);
    expect(modems().map((modem) => modem.equipment_id)).toEqual(['MODEM_4']);
  });

  test('rejects a payload that is not the documented shape without touching D1', async () => {
    const cases: [unknown, string][] = [
      [
        { ...devicesBody(), removed_equipment_ids: undefined },
        'modem_reports and removed_equipment_ids must be arrays',
      ],
      [
        { modems: [report()], sims: [], sync_mode: 'incremental', session_id: 's' },
        'modem_reports and removed_equipment_ids must be arrays',
      ],
      [devicesBody('incremental', [{ equipment_id: 5 }]), 'Invalid modem report'],
      [devicesBody('incremental', [{ manufacturer: 'Quectel' }]), 'Invalid modem report'],
      [devicesBody('incremental', [report({ signal_percent: 80.5 })]), 'Invalid modem report'],
      [devicesBody('incremental', [null]), 'Invalid modem report'],
      [
        { ...devicesBody(), sync_mode: 'partial' },
        'Invalid sync mode or missing full-sync session ID',
      ],
      [
        { ...devicesBody('full'), session_id: null },
        'Invalid sync mode or missing full-sync session ID',
      ],
      [
        { ...devicesBody('full'), session_id: '' },
        'Invalid sync mode or missing full-sync session ID',
      ],
      [
        { ...devicesBody('full'), session_id: 5 },
        'Invalid sync mode or missing full-sync session ID',
      ],
      [devicesBody('incremental', [], [7]), 'Invalid or conflicting removed equipment IDs'],
      [devicesBody('incremental', [], ['']), 'Invalid or conflicting removed equipment IDs'],
      [
        devicesBody('incremental', [report()], ['modem-a']),
        'Invalid or conflicting removed equipment IDs',
      ],
    ];
    for (const [body, error] of cases) {
      const response = await controlHandler.updateDevices(
        controlRequest(body, { database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(error);
    }
  });

  test('defaults an absent sync mode to incremental', async () => {
    const result = await syncDevices({
      ...devicesBody(),
      sync_mode: undefined,
      session_id: undefined,
    });
    expect(result).toMatchObject({ sync_mode: 'incremental', session_id: null });
  });
});

const UploadResult = v.object({
  success: v.literal(true),
  processed: v.number(),
  results: v.array(
    v.object({ id: v.string(), status: v.string(), retryable: v.optional(v.boolean()) }),
  ),
  message: v.string(),
});

const StoredRow = v.object({
  id: v.string(),
  phone_iccid: v.nullable(v.string()),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  timestamp: v.nullable(v.string()),
  type: v.nullable(v.string()),
  status: v.nullable(v.string()),
  verification_code: v.nullable(v.string()),
  filter_status: v.string(),
  filter_rule_id: v.nullable(v.number()),
  purpose: v.string(),
  balance_check_id: v.nullable(v.string()),
});

const STORED_COLUMNS = `id, phone_iccid, phone_number, content, timestamp, type, status,
  verification_code, filter_status, filter_rule_id, purpose, balance_check_id`;

function stored(id: string) {
  return one(StoredRow, `SELECT ${STORED_COLUMNS} FROM messages WHERE id = ?`, id);
}

interface Upload {
  id?: unknown;
  phone_iccid?: unknown;
  phone_number?: unknown;
  content?: unknown;
  timestamp?: unknown;
  direction?: unknown;
}

function sms(fields: Upload = {}): Upload {
  return {
    id: 'msg-1',
    phone_iccid: ICCID,
    phone_number: '+6590000000',
    content: 'hello',
    timestamp: '2026-09-03T00:00:00.000Z',
    direction: 'received',
    ...fields,
  };
}

async function upload(messages: Upload[], options: RequestOptions = {}) {
  const response = await controlHandler.uploadMessages(controlRequest({ messages }, options));
  expect(response.status).toBe(200);
  return read(response, UploadResult);
}

describe('POST /api/control/messages', () => {
  test('stores a received message with its verification code', async () => {
    const result = await upload([sms({ content: '您的验证码是 482913，5分钟内有效。' })]);

    expect(result).toEqual({
      success: true,
      processed: 1,
      results: [{ id: 'msg-1', status: 'stored' }],
      message: 'Successfully uploaded 1 messages',
    });
    expect(stored('msg-1')).toEqual({
      id: 'msg-1',
      phone_iccid: ICCID,
      phone_number: '+6590000000',
      content: '您的验证码是 482913，5分钟内有效。',
      timestamp: '2026-09-03T00:00:00.000Z',
      type: 'received',
      status: 'received',
      verification_code: '482913',
      filter_status: 'clean',
      filter_rule_id: null,
      purpose: 'user',
      balance_check_id: null,
    });
  });

  test('acknowledges retries by stable ID while preserving equal SMS payloads with distinct IDs', async () => {
    const first = sms({ id: '018c1a55-73a0-7b9b-8c06-123456789abc', content: 'same SMS' });
    const second = { ...first, id: '018c1a55-73a0-7b9b-8c06-123456789abd' };

    expect((await upload([first, second])).results).toEqual([
      { id: '018c1a55-73a0-7b9b-8c06-123456789abc', status: 'stored' },
      { id: '018c1a55-73a0-7b9b-8c06-123456789abd', status: 'stored' },
    ]);
    const retry = await upload([first]);
    expect(retry).toMatchObject({
      processed: 0,
      results: [{ id: first.id, status: 'already_stored' }],
    });
    expect(count(`SELECT COUNT(*) AS count FROM messages`)).toBe(2);
  });

  test('normalizes the timestamp formats the daemon has sent', async () => {
    const cases: [unknown, string][] = [
      ['2026-09-03 08:05:06', '2026-09-03T08:05:06.000Z'],
      ['2026-09-03+8:5:6', '2026-09-03T08:05:06.000Z'],
      ['2026-09-03T08:05:06.123Z', '2026-09-03T08:05:06.123Z'],
      ['2026-09-03T08:05:06', '2026-09-03T08:05:06.000Z'],
      ['2026-09-03 T 08:05', '2026-09-03T08:05'],
    ];
    for (const [index, [timestamp, expected]] of cases.entries()) {
      await upload([sms({ id: `msg-${String(index)}`, timestamp })]);
      expect(stored(`msg-${String(index)}`).timestamp).toBe(expected);
    }

    await upload([sms({ id: 'msg-now', timestamp: undefined })]);
    expect(Date.parse(stored('msg-now').timestamp ?? '')).toBeGreaterThan(Date.now() - 60_000);
  });

  test('files a message from a spam sender as filtered', async () => {
    sqlite.run(
      `INSERT INTO filter_rules (id, rule_type, pattern) VALUES (7, 'sender', '+6590000000')`,
    );

    await upload([sms()]);

    expect(stored('msg-1')).toMatchObject({ filter_status: 'filtered', filter_rule_id: 7 });
  });

  test('tags keywords in the background', async () => {
    sqlite.run(`
      INSERT INTO keyword_tags (id, keyword, tag, is_active, priority) VALUES
        (1, 'hello', 'greeting', TRUE, 1),
        (2, 'hello', 'inactive', FALSE, 1);
    `);

    await upload([sms({ content: 'hello world, hello' })]);
    await Promise.all(background);

    expect(
      every(
        Row,
        `SELECT message_id, keyword_tag_id, matched_text, position FROM message_tags ORDER BY position`,
      ),
    ).toEqual([
      { message_id: 'msg-1', keyword_tag_id: 1, matched_text: 'hello', position: 0 },
      { message_id: 'msg-1', keyword_tag_id: 1, matched_text: 'hello', position: 13 },
    ]);
  });

  test('links a balance reply to its pending check instead of the inbox', async () => {
    insertBalanceSim();
    insertPendingCheck('check-1');

    await upload([sms({ phone_number: '10086', content: '您的账户余额为82.36元。' })]);

    expect(stored('msg-1')).toMatchObject({
      verification_code: null,
      filter_status: 'filtered',
      purpose: 'balance_maintenance',
      balance_check_id: 'check-1',
    });
    expect(
      one(Row, `SELECT status, response_message_id FROM sim_balance_checks WHERE id = 'check-1'`),
    ).toEqual({ status: 'parsed', response_message_id: 'msg-1' });
    expect(background).toHaveLength(0);
  });

  test('parses a multipart balance reply once, from its merged text', async () => {
    insertBalanceSim();
    insertPendingCheck('check-1');
    const part = { phone_number: '10086', timestamp: '2026-09-03T00:00:00.000Z' };

    const result = await upload([
      sms({ ...part, id: 'part-1', content: '国移动】' }),
      sms({ ...part, id: 'part-2', content: '您的账户余额为199.88元' }),
    ]);

    expect(result.processed).toBe(2);
    expect(
      one(Row, `SELECT status, response_message_id, raw_response FROM sim_balance_checks`),
    ).toEqual({
      status: 'parsed',
      response_message_id: 'part-1',
      raw_response: '国移动】您的账户余额为199.88元',
    });
    expect(stored('part-2')).toMatchObject({
      purpose: 'balance_maintenance',
      balance_check_id: 'check-1',
    });
  });

  test('reports one failed message without aborting the batch', async () => {
    const flaky: TestDb = {
      prepare: (sql) => {
        const statement = db.prepare(sql);
        if (!sql.includes('INSERT INTO messages')) return statement;
        return {
          ...statement,
          bind: (...values) => {
            const bound = statement.bind(...values);
            if (values[0] === 'msg-bad') {
              return { ...bound, run: () => Promise.reject(new Error('D1 busy')) };
            }
            if (values[0] === 'msg-type') {
              return { ...bound, run: () => Promise.reject(new TypeError('bad value')) };
            }
            return bound;
          },
        };
      },
      batch: (statements) => db.batch(statements),
    };

    const result = await upload(
      [sms({ id: 'msg-bad' }), sms({ id: 'msg-type' }), sms({ id: 'msg-good' })],
      { database: flaky },
    );

    expect(result.results).toEqual([
      { id: 'msg-bad', status: 'rejected', retryable: true },
      { id: 'msg-type', status: 'rejected', retryable: false },
      { id: 'msg-good', status: 'stored' },
    ]);
    expect(result.processed).toBe(1);
  });

  test('rejects a batch that is not the documented shape without touching D1', async () => {
    const cases: [unknown, string][] = [
      [{}, 'Messages must be an array'],
      [{ messages: 'x' }, 'Messages must be an array'],
      [{ messages: [sms({ id: undefined })] }, 'Every message requires a daemon-assigned id'],
      [{ messages: [sms({ id: 7 })] }, 'Every message requires a daemon-assigned id'],
      [{ messages: ['x'] }, 'Every message requires a daemon-assigned id'],
      [{ messages: [sms({ phone_iccid: '' })] }, 'Every message requires phone_iccid and content'],
      [
        { messages: [sms({ content: undefined })] },
        'Every message requires phone_iccid and content',
      ],
      [{ messages: [sms({ phone_number: 10086 })] }, 'phone_number and timestamp must be text'],
      [{ messages: [sms({ timestamp: 1 })] }, 'phone_number and timestamp must be text'],
    ];
    for (const [body, error] of cases) {
      const response = await controlHandler.uploadMessages(
        controlRequest(body, { database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await read(response, ErrorBody)).toEqual({ success: false, error });
    }
  });
});

function insertBalanceSim(): void {
  sqlite
    .query(`INSERT INTO sims (iccid, sim_index, phone_number) VALUES (?, 1, ?)`)
    .run(ICCID, NUMBER);
}

function insertPendingCheck(id: string): void {
  sqlite
    .query(
      `INSERT INTO sim_balance_checks (
         id, sim_iccid, profile_id, status, parser_version, step_index, requested_at, sent_at,
         deadline_at
       ) VALUES (?, ?, 'cn-mobile-sms-menu-v1', 'awaiting_response', 'cn-mobile-balance-v1', 2,
         '2026-09-02 23:50:00', '2026-09-02 23:50:00', '2999-01-01 00:00:00')`,
    )
    .run(id, ICCID);
}

const PendingBody = v.object({ success: v.literal(true), pending_messages: v.array(Row) });

function insertOutbound(
  id: string,
  {
    purpose = 'user',
    status = 'sending',
    createdAt = '2026-09-03 00:00:00',
    session = null,
  }: { purpose?: string; status?: string; createdAt?: string; session?: string | null } = {},
): void {
  sqlite
    .query(
      `INSERT INTO messages (
         id, phone_iccid, phone_number, content, type, recipient, status, filter_status,
         purpose, processing_session_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'YE', 'sent', '10010', ?, 'filtered', ?, ?, ?, ?)`,
    )
    .run(id, ICCID, NUMBER, status, purpose, session, createdAt, createdAt);
}

function outboundState(id: string) {
  return one(
    v.object({
      status: v.nullable(v.string()),
      processing_session_id: v.nullable(v.string()),
      error_message: v.nullable(v.string()),
    }),
    `SELECT status, processing_session_id, error_message FROM messages WHERE id = ?`,
    id,
  );
}

function poll(session: string | null = 'rust-daemon-session-2', database: TestDb = db) {
  return controlHandler.getPendingSMS(
    controlRequest(null, {
      headers: session === null ? {} : { 'X-Daemon-Session-Id': session },
      database,
    }),
  );
}

describe('GET /api/control/pending-sms', () => {
  test('accepts only bounded, inert session identifiers', () => {
    expect(normalizeDaemonSessionId('rust-daemon-abc_123')).toBe('rust-daemon-abc_123');
    expect(normalizeDaemonSessionId('bad session')).toBeNull();
    expect(normalizeDaemonSessionId("x' OR 1=1")).toBeNull();
    expect(normalizeDaemonSessionId('s'.repeat(121))).toBeNull();
    expect(normalizeDaemonSessionId(null)).toBeNull();
  });

  test('claims pending messages for this session and returns them oldest first', async () => {
    insertOutbound('msg-2', { createdAt: '2026-09-03 00:00:02' });
    insertOutbound('msg-1', { createdAt: '2026-09-03 00:00:01' });
    insertOutbound('msg-sent', { status: 'sent' });

    const response = await poll();

    expect(response.status).toBe(200);
    expect((await read(response, PendingBody)).pending_messages).toEqual([
      {
        id: 'msg-1',
        phone_iccid: ICCID,
        phone_number: NUMBER,
        content: 'YE',
        recipient: '10010',
        purpose: 'user',
        created_at: '2026-09-03 00:00:01',
      },
      {
        id: 'msg-2',
        phone_iccid: ICCID,
        phone_number: NUMBER,
        content: 'YE',
        recipient: '10010',
        purpose: 'user',
        created_at: '2026-09-03 00:00:02',
      },
    ]);
    expect(outboundState('msg-1')).toEqual({
      status: 'processing',
      processing_session_id: 'rust-daemon-session-2',
      error_message: null,
    });
    expect(outboundState('msg-sent').status).toBe('sent');
  });

  test('sends user messages first and at most five maintenance messages per poll', async () => {
    for (let index = 0; index < 7; index++) {
      insertOutbound(`bal-${String(index)}`, {
        purpose: 'balance_maintenance',
        createdAt: `2026-09-03 00:00:0${String(index)}`,
      });
    }
    insertOutbound('user-late', { createdAt: '2026-09-03 00:00:09' });

    const { pending_messages } = await read(await poll(), PendingBody);

    expect(pending_messages.map((message) => message['id'])).toEqual([
      'bal-0',
      'bal-1',
      'bal-2',
      'bal-3',
      'bal-4',
      'user-late',
    ]);
    expect(outboundState('bal-5').status).toBe('sending');
  });

  test('claims at most fifty messages', async () => {
    for (let index = 0; index < 55; index++) {
      insertOutbound(`msg-${String(index).padStart(2, '0')}`);
    }
    expect((await read(await poll(), PendingBody)).pending_messages).toHaveLength(50);
  });

  test('marks interrupted claims unknown instead of sending them again', async () => {
    insertOutbound('other-session', { status: 'processing', session: 'rust-daemon-session-1' });
    insertOutbound('old-unsessioned', { status: 'processing', createdAt: '2000-01-01 00:00:00' });
    insertOutbound('fresh-unsessioned', { status: 'processing', createdAt: '2999-01-01 00:00:00' });
    insertOutbound('this-session', { status: 'processing', session: 'rust-daemon-session-2' });

    await poll();

    const unknown = {
      status: 'unknown',
      processing_session_id: null,
      error_message: 'Daemon restarted before confirming SMS delivery; delivery status is unknown',
    };
    expect(outboundState('other-session')).toEqual(unknown);
    expect(outboundState('old-unsessioned')).toEqual(unknown);
    expect(outboundState('fresh-unsessioned').status).toBe('processing');
    expect(outboundState('this-session').status).toBe('processing');
  });

  test('claims without a session, and recovers nothing, when the daemon sends no session', async () => {
    insertOutbound('interrupted', { status: 'processing', session: 'rust-daemon-session-1' });
    insertOutbound('msg-1');

    await poll(null);

    expect(outboundState('interrupted').status).toBe('processing');
    expect(outboundState('msg-1')).toMatchObject({
      status: 'processing',
      processing_session_id: null,
    });
  });

  test('an empty poll answers no messages and writes nothing', async () => {
    const response = await poll(null);
    expect(await response.json()).toEqual({ success: true, pending_messages: [] });
    expect(count(`SELECT COUNT(*) AS count FROM daemon_health`)).toBe(0);
  });

  test('answers 500 rather than hand the daemon a row that drifted from its schema', async () => {
    insertOutbound('msg-1');
    sqlite.run(`UPDATE messages SET created_at = 5`);

    const response = await poll();

    expect(response.status).toBe(500);
    expect(await read(response, ErrorBody)).toEqual({
      success: false,
      error: 'Failed to get pending SMS',
    });
  });

  test('rejects a malformed session header before touching the database', async () => {
    const response = await poll("x' OR 1=1", untouchable);
    expect(response.status).toBe(400);
    expect(await read(response, ErrorBody)).toEqual({
      success: false,
      error: 'Invalid daemon session ID',
    });
  });
});

describe('POST /api/control/sms-result', () => {
  beforeEach(() => {
    insertBalanceSim();
    sqlite.run(`
      INSERT INTO sim_balance_checks (id, sim_iccid, profile_id, status, parser_version)
      VALUES ('check-1', '${ICCID}', 'cn-mobile-sms-menu-v1', 'queued', 'cn-mobile-balance-v1');
    `);
    insertOutbound('msg-1', { status: 'processing', session: 'rust-daemon-session-2' });
    sqlite.run(`UPDATE messages SET balance_check_id = 'check-1', purpose = 'balance_maintenance'`);
  });

  function result(body: unknown, database: TestDb = db) {
    return controlHandler.updateSMSResult(controlRequest(body, { database }));
  }

  function checkState() {
    return one(
      v.object({
        status: v.string(),
        error: v.nullable(v.string()),
        sent_at: v.nullable(v.string()),
      }),
      `SELECT status, error, sent_at FROM sim_balance_checks WHERE id = 'check-1'`,
    );
  }

  test('records a confirmed send and starts the balance reply window', async () => {
    const response = await result({ message_id: 'msg-1', outcome: 'confirmed', sms_id: 'sms-9' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: 'SMS result updated successfully',
    });
    expect(
      one(Row, `SELECT status, error_message, sms_id, processing_session_id FROM messages`),
    ).toEqual({
      status: 'sent',
      error_message: null,
      sms_id: 'sms-9',
      processing_session_id: null,
    });
    expect(checkState().status).toBe('awaiting_response');
  });

  test('records an unconfirmed modem submission as unknown without failing its balance check', async () => {
    await result({
      message_id: 'msg-1',
      outcome: 'submitted_unconfirmed',
      error_message: 'SMS body submitted; modem did not return a final confirmation',
    });

    expect(one(Row, `SELECT status, error_message FROM messages`)).toEqual({
      status: 'unknown',
      error_message: 'SMS body submitted; modem did not return a final confirmation',
    });
    expect(checkState()).toMatchObject({ status: 'awaiting_response', error: null });
  });

  test('fails the message and its balance check on an explicit failure', async () => {
    await result({
      message_id: 'msg-1',
      outcome: 'failed',
      error_message: 'No modem found for ICCID',
    });

    expect(one(Row, `SELECT status, error_message FROM messages`)).toEqual({
      status: 'failed',
      error_message: 'No modem found for ICCID',
    });
    expect(checkState()).toMatchObject({ status: 'failed', error: 'No modem found for ICCID' });
  });

  test('stores an empty error message as none', async () => {
    await result({ message_id: 'msg-1', outcome: 'failed', error_message: '', sms_id: '' });

    expect(one(Row, `SELECT error_message, sms_id FROM messages`)).toEqual({
      error_message: null,
      sms_id: null,
    });
    expect(checkState().error).toBe('SMS send failed');
  });

  test('answers 404 for an unknown message', async () => {
    const response = await result({ message_id: 'nope', outcome: 'confirmed' });
    expect(response.status).toBe(404);
    expect(await read(response, ErrorBody)).toEqual({ success: false, error: 'Message not found' });
  });

  test('rejects a result that is not the documented shape without touching D1', async () => {
    const cases: [unknown, string][] = [
      [{ outcome: 'confirmed' }, 'message_id is required'],
      [{ message_id: '', outcome: 'confirmed' }, 'message_id is required'],
      [{ message_id: 5, outcome: 'confirmed' }, 'message_id is required'],
      [
        { message_id: 'msg-1', success: true },
        'outcome must be confirmed, submitted_unconfirmed, or failed',
      ],
      [
        { message_id: 'msg-1', outcome: 'sent' },
        'outcome must be confirmed, submitted_unconfirmed, or failed',
      ],
      [{ message_id: 'msg-1', outcome: 'failed', error_message: {} }, 'error_message must be text'],
      [{ message_id: 'msg-1', outcome: 'failed', sms_id: 7 }, 'sms_id must be text'],
    ];
    for (const [body, error] of cases) {
      const response = await result(body, untouchable);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(error);
    }
  });
});

describe('POST /api/control/cleanup-test-data', () => {
  test('deletes the listed SIMs and any SIM without an ICCID', async () => {
    sqlite.run(`
      INSERT INTO sims (iccid, sim_index, phone_number) VALUES
        ('test-1', 1, '+1'), ('test-2', 2, '+2'), ('keep', 3, '+3'), ('', 4, '+4');
    `);

    const response = await controlHandler.cleanupTestData(
      controlRequest({ phoneIds: ['test-1', 'test-2', 'missing'] }),
    );

    expect(await response.json()).toEqual({
      success: true,
      deleted: 2,
      cleanedNullIccid: 1,
      message: 'Deleted 2 test SIMs and 1 SIMs without ICCID',
    });
    expect(every(Row, `SELECT iccid FROM sims`)).toEqual([{ iccid: 'keep' }]);
  });

  test('requires a non-empty list of ICCIDs', async () => {
    const cases: [unknown, string][] = [
      [{}, 'phoneIds must be an array'],
      [{ phoneIds: 'test-1' }, 'phoneIds must be an array'],
      [{ phoneIds: [] }, 'phoneIds must be a non-empty array of ICCIDs'],
      [{ phoneIds: [5] }, 'phoneIds must be a non-empty array of ICCIDs'],
      [{ phoneIds: [''] }, 'phoneIds must be a non-empty array of ICCIDs'],
    ];
    for (const [body, error] of cases) {
      const response = await controlHandler.cleanupTestData(
        controlRequest(body, { database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(error);
    }
  });
});

describe('DELETE /api/control/messages', () => {
  test('deletes every message', async () => {
    insertOutbound('msg-1');
    insertOutbound('msg-2');

    const response = await controlHandler.clearMessages(controlRequest(null));

    expect(await response.json()).toEqual({ success: true, message: 'Cleared 2 messages' });
    expect(count(`SELECT COUNT(*) AS count FROM messages`)).toBe(0);
  });
});

const HealthRow = v.object({
  daemon_id: v.string(),
  status: v.nullable(v.string()),
  last_ip: v.nullable(v.string()),
  version: v.nullable(v.string()),
  error_count: v.nullable(v.number()),
  metadata: v.nullable(v.string()),
  current_session_id: v.nullable(v.string()),
});

function snapshot(fields: Record<string, unknown> = {}) {
  return {
    schema_version: 3,
    session_id: 'rust-daemon-session-2',
    version: '8.1.0',
    uptime_seconds: 60,
    last_message_read_success_age_seconds: 5,
    last_upload_success_age_seconds: 7,
    queue: { pending: 1, in_flight: 0, dead_letter: 0, oldest_unacknowledged_age_seconds: 3 },
    ...fields,
  };
}

describe('POST /api/control/heartbeat', () => {
  function health() {
    return one(
      HealthRow,
      `SELECT daemon_id, status, last_ip, version, error_count, metadata, current_session_id
       FROM daemon_health`,
    );
  }

  test('stores the normalized health snapshot and the client address', async () => {
    const response = await controlHandler.heartbeat(
      controlRequest(snapshot(), {
        headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '10.0.0.1' },
      }),
    );

    expect(response.status).toBe(200);
    expect(
      await read(
        response,
        v.object({ success: v.literal(true), message: v.string(), received_at: v.string() }),
      ),
    ).toMatchObject({ message: 'Heartbeat received' });
    expect(health()).toEqual({
      daemon_id: 'orange-pi-main',
      status: 'online',
      last_ip: '203.0.113.7',
      version: '8.1.0',
      error_count: 0,
      metadata: JSON.stringify(snapshot()),
      current_session_id: 'rust-daemon-session-2',
    });
  });

  test('falls back to the forwarded address, then to unknown', async () => {
    await controlHandler.heartbeat(
      controlRequest(snapshot(), { headers: { 'X-Forwarded-For': '10.0.0.1' } }),
    );
    expect(health().last_ip).toBe('10.0.0.1');

    await controlHandler.heartbeat(controlRequest(snapshot({ version: '8.2.0' })));
    expect(health()).toMatchObject({ last_ip: 'unknown', version: '8.2.0' });
    expect(count(`SELECT COUNT(*) AS count FROM daemon_health`)).toBe(1);
  });

  test('rejects an unsupported or incomplete snapshot', async () => {
    const cases: [unknown, string][] = [
      [
        snapshot({ schema_version: 2 }),
        'Failed to process heartbeat: Unsupported health schema version: 2',
      ],
      [
        snapshot({ session_id: '' }),
        'Failed to process heartbeat: session_id and version are required',
      ],
      [
        snapshot({ version: undefined }),
        'Failed to process heartbeat: session_id and version are required',
      ],
    ];
    for (const [body, error] of cases) {
      const response = await controlHandler.heartbeat(
        controlRequest(body, { database: untouchable }),
      );
      expect(response.status).toBe(400);
      expect(await read(response, ErrorBody)).toEqual({ success: false, error });
    }
  });
});
