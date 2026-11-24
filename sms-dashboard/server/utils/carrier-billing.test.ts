import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Statement } from '../lib/d1.js';
import {
  processCarrierBillMessages,
  processCarrierBillMessage,
  reconcileCarrierBillMessages,
  type BillProcessingResult,
} from './carrier-billing.js';

const ACCOUNT_REFERENCE = '12345678';

function billMessage({
  amount = '42.80',
  dueDate = '14 Sep 2026',
  account = ACCOUNT_REFERENCE,
}: { amount?: string; dueDate?: string; account?: string } = {}) {
  return `<Singtel>Dear customer, your latest bill for Singtel a/c ${account} is ready. The total amount is SGD$${amount} due on ${dueDate}. You can view and pay this bill via My Singtel app at www.singtel.com/viewbill .@`;
}

let database: Database;
let db: D1;
let preparedSql: string[];

beforeEach(async () => {
  preparedSql = [];
  database = new Database(':memory:');
  database.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (
      iccid TEXT PRIMARY KEY,
      service_type TEXT NOT NULL,
      country_code TEXT,
      carrier TEXT,
      sim_index INTEGER
    );
    CREATE VIEW device_view AS
      SELECT iccid, service_type, country_code AS country, carrier, sim_index FROM sims;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp TIMESTAMP,
      type TEXT
    );
    INSERT INTO sims VALUES
      ('notification-sim', 'postpaid', 'SG', 'Singtel', 79),
      ('prepaid-sim', 'prepaid', 'SG', 'Singtel', 80),
      ('wrong-carrier', 'postpaid', 'SG', 'StarHub', 81),
      ('unnumbered-sim', 'postpaid', 'SG', 'Singtel', NULL);
  `);
  const migration = await Bun.file(
    new URL('../../migrations/066_add_carrier_billing.sql', import.meta.url),
  ).text();
  database.run(migration);
  const streamMigration = await Bun.file(
    new URL('../../migrations/069_unique_active_billing_stream_per_sim.sql', import.meta.url),
  ).text();
  database.run(streamMigration);
  const real = sqliteD1(database);
  db = {
    prepare: (sql) => {
      preparedSql.push(sql);
      return real.prepare(sql);
    },
  };
});

interface Overrides {
  id?: string;
  iccid?: string;
  sender?: string;
  content?: string;
  timestamp?: string;
  type?: string;
}

function insertMessage({
  id = 'message-1',
  iccid = 'notification-sim',
  sender = 'Singtel',
  content = billMessage(),
  timestamp = '2026-08-24T01:02:03Z',
  type = 'received',
}: Overrides = {}) {
  database
    .query(
      `
    INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(id, iccid, sender, content, timestamp, type);
  return { id, phone_iccid: iccid, phone_number: sender, content, timestamp, type };
}

function bills() {
  return database
    .query(
      `
    SELECT billing_account_id, source_message_id, amount_minor, currency,
      due_date, action_status, version
    FROM carrier_bills ORDER BY due_date
  `,
    )
    .all();
}

function events() {
  return database
    .query(
      `
    SELECT event_type, source_message_id FROM carrier_bill_events
    ORDER BY event_type, source_message_id
  `,
    )
    .all();
}

function accounts() {
  return database
    .query(
      `
    SELECT notification_sim_iccid, account_ref_last4, status, created_by, display_name
    FROM carrier_billing_accounts
  `,
    )
    .all();
}

function members() {
  return database
    .query(
      `
    SELECT sim_iccid, verification_source, verified_by
    FROM carrier_billing_account_sims
    WHERE removed_at IS NULL
  `,
    )
    .all();
}

function cannedDb(row: unknown): D1<'first' | 'all' | 'run'> {
  const statement: D1Statement = {
    bind: () => statement,
    first: () => Promise.resolve(row),
    all: () => Promise.resolve({ results: [row] }),
    run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
  };
  return { prepare: () => statement };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('carrier bill SMS processing', () => {
  test('creates one normalized bill and a detected event', async () => {
    const result = await processCarrierBillMessage(db, insertMessage());

    expect(result.outcome).toBe('detected');
    expect(typeof result.bill_id).toBe('string');
    expect(bills()).toMatchObject([
      {
        source_message_id: 'message-1',
        amount_minor: 4280,
        currency: 'SGD',
        due_date: '2026-09-14',
        action_status: 'unpaid',
        version: 1,
      },
    ]);
    expect(accounts()).toEqual([
      {
        notification_sim_iccid: 'notification-sim',
        account_ref_last4: '5678',
        status: 'active',
        created_by: 'system:sms',
        display_name: 'S79 Singtel postpaid',
      },
    ]);
    expect(members()).toEqual([
      {
        sim_iccid: 'notification-sim',
        verification_source: 'contract_or_bill',
        verified_by: 'system:sms',
      },
    ]);
    expect(events()).toEqual([{ event_type: 'detected', source_message_id: 'message-1' }]);
  });

  test('names the account after a SIM without an index', async () => {
    await processCarrierBillMessage(db, insertMessage({ iccid: 'unnumbered-sim' }));

    expect(accounts()).toMatchObject([{ display_name: 'S00 Singtel postpaid' }]);
  });

  test('is idempotent when the same source message is retried', async () => {
    const message = insertMessage();
    await processCarrierBillMessage(db, message);
    const retry = await processCarrierBillMessage(db, message);

    expect(retry.outcome).toBe('already_processed');
    expect(bills()).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });

  test('reports the bill a retried message created', async () => {
    const message = insertMessage();
    const first = await processCarrierBillMessage(db, message);
    const retry = await processCarrierBillMessage(db, message);

    expect(retry.outcome).toBe('already_processed');
    expect(typeof first.bill_id).toBe('string');
    expect(retry.bill_id).toBe(first.bill_id);
  });

  test('records a same-cycle same-amount source as a duplicate only once', async () => {
    await processCarrierBillMessage(db, insertMessage());
    const duplicate = insertMessage({ id: 'message-2', timestamp: '2026-08-24T01:03:03Z' });

    await processCarrierBillMessage(db, duplicate);
    await processCarrierBillMessage(db, duplicate);

    expect(bills()).toHaveLength(1);
    expect(events()).toEqual([
      { event_type: 'detected', source_message_id: 'message-1' },
      { event_type: 'duplicate_detected', source_message_id: 'message-2' },
    ]);
  });

  test('preserves evidence and marks a conflicting amount for review', async () => {
    await processCarrierBillMessage(db, insertMessage());
    const conflict = insertMessage({
      id: 'message-2',
      content: billMessage({ amount: '52.80' }),
    });

    await processCarrierBillMessage(db, conflict);
    await processCarrierBillMessage(db, conflict);

    expect(bills()[0]).toMatchObject({
      amount_minor: 4280,
      action_status: 'needs_review',
      version: 2,
    });
    expect(events()).toContainEqual({
      event_type: 'parse_conflict',
      source_message_id: 'message-2',
    });
  });

  test.each([
    ['wrong SIM', { iccid: 'prepaid-sim' }],
    ['wrong carrier', { iccid: 'wrong-carrier' }],
    ['unknown SIM', { iccid: 'no-such-sim' }],
    ['wrong sender', { sender: 'Singtel Biz' }],
    ['wrong message type', { type: 'sent' }],
    ['unsupported content', { content: 'Your bill is ready.' }],
  ])('rejects %s', async (_name, overrides) => {
    const result = await processCarrierBillMessage(db, insertMessage(overrides));

    expect(result.outcome).toBe('ignored');
    expect(bills()).toEqual([]);
  });

  test('rejects a bill for another account on a SIM that already has a stream', async () => {
    await processCarrierBillMessage(db, insertMessage());
    const other = insertMessage({ id: 'message-2', content: billMessage({ account: '87654321' }) });

    expect(await processCarrierBillMessage(db, other)).toEqual({ outcome: 'ignored' });
    expect(bills()).toHaveLength(1);
    expect(accounts()).toHaveLength(1);
  });

  test('rejects a bill whose currency differs from the stream', async () => {
    await processCarrierBillMessage(db, insertMessage());
    database.query(`UPDATE carrier_billing_accounts SET currency = 'USD'`).run();

    const next = insertMessage({
      id: 'message-2',
      content: billMessage({ dueDate: '14 Oct 2026' }),
    });
    expect(await processCarrierBillMessage(db, next)).toEqual({ outcome: 'ignored' });
    expect(bills()).toHaveLength(1);
  });

  test.each([
    ['nothing', null],
    ['text', 'bill'],
    ['an object without the message fields', {}],
    ['a message without an id', { phone_iccid: 'a', content: 'c', timestamp: 't' }],
    [
      'a message with a numeric timestamp',
      {
        id: 'x',
        type: 'received',
        phone_number: 'Singtel',
        phone_iccid: 'notification-sim',
        content: billMessage(),
        timestamp: 1,
      },
    ],
  ])('ignores %s', async (_name, message) => {
    expect(await processCarrierBillMessage(db, message)).toEqual({ outcome: 'ignored' });
    expect(preparedSql).toEqual([]);
  });

  test('rejects an account whose notification SIM inventory is no longer eligible', async () => {
    const message = insertMessage();
    database
      .query(`UPDATE sims SET service_type = 'prepaid' WHERE iccid = 'notification-sim'`)
      .run();

    expect(await processCarrierBillMessage(db, message)).toEqual({ outcome: 'ignored' });
    expect(bills()).toEqual([]);
  });

  test('fails when the SIM row does not match its schema', async () => {
    const error = await failure(
      processCarrierBillMessage(cannedDb({ iccid: 7, sim_index: 'x' }), insertMessage()),
    );
    expect(error).toBeInstanceOf(Error);
  });

  test('fails when the stream row does not match its schema', async () => {
    const statements: unknown[] = [{ iccid: 'notification-sim', sim_index: 79 }, { id: 1 }];
    const statement: D1Statement = {
      bind: () => statement,
      first: () => Promise.resolve(statements.shift()),
      all: () => Promise.resolve({ results: [] }),
      run: () => Promise.resolve({ meta: { changes: 1, last_row_id: 0 } }),
    };

    const error = await failure(
      processCarrierBillMessage({ prepare: () => statement }, insertMessage()),
    );
    expect(error).toBeInstanceOf(Error);
  });

  test('scheduled reconciliation recovers eligible missed messages', async () => {
    insertMessage({ id: 'message-1' });
    insertMessage({ id: 'message-2', content: 'Not a bill' });

    const result = await reconcileCarrierBillMessages(db);

    expect(result).toEqual({ scanned: 1, detected: 1, remaining: 0 });
    expect(bills()).toHaveLength(1);
    expect(events()).toHaveLength(1);
    expect(preparedSql.some((sql) => sql.includes('m.content LIKE'))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes('instr(m.content, ?) = 1'))).toBe(true);
  });

  test('reconciliation skips messages that were already processed', async () => {
    const processed = insertMessage({ id: 'message-1' });
    await processCarrierBillMessage(db, processed);
    insertMessage({
      id: 'message-2',
      content: billMessage({ dueDate: '14 Oct 2026' }),
      timestamp: '2026-09-24T01:02:03Z',
    });

    expect(await reconcileCarrierBillMessages(db)).toEqual({
      scanned: 1,
      detected: 1,
      remaining: 0,
    });
    expect(bills()).toHaveLength(2);
  });

  test('reconciliation takes the newest messages first and reports what remains', async () => {
    insertMessage({ id: 'old', timestamp: '2026-07-24T01:02:03Z' });
    insertMessage({
      id: 'new',
      content: billMessage({ dueDate: '14 Oct 2026' }),
      timestamp: '2026-09-24T01:02:03Z',
    });

    expect(await reconcileCarrierBillMessages(db, { pageSize: 1 })).toEqual({
      scanned: 1,
      detected: 1,
      remaining: 1,
    });
    expect(bills()).toMatchObject([{ source_message_id: 'new' }]);
  });

  test('reconciliation reads a page size of zero as the default', async () => {
    insertMessage({ id: 'message-1' });

    expect(await reconcileCarrierBillMessages(db, { pageSize: 0 })).toEqual({
      scanned: 1,
      detected: 1,
      remaining: 0,
    });
  });

  test('reconciliation counts a message without a timestamp as scanned but not detected', async () => {
    database
      .query(
        `INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type)
         VALUES ('no-time', 'notification-sim', 'Singtel', ?, NULL, 'received')`,
      )
      .run(billMessage());

    expect(await reconcileCarrierBillMessages(db)).toEqual({
      scanned: 1,
      detected: 0,
      remaining: 0,
    });
    expect(bills()).toEqual([]);
  });

  test('reconciliation fails when a candidate row does not match its schema', async () => {
    const error = await failure(reconcileCarrierBillMessages(cannedDb({ id: 1 })));
    expect(error).toBeInstanceOf(Error);
  });

  test('isolates one processing failure from the rest of an upload batch', async () => {
    const errors: [unknown, unknown][] = [];
    const processed: unknown[] = [];
    const processMessage = (_database: D1, message: unknown): Promise<BillProcessingResult> => {
      if (typeof message === 'object' && message !== null && 'id' in message) {
        if (message.id === 'broken') return Promise.reject(new Error('database unavailable'));
        processed.push(message.id);
      }
      return Promise.resolve({ outcome: 'detected' });
    };

    const results = await processCarrierBillMessages(db, [{ id: 'broken' }, { id: 'healthy' }], {
      processMessage,
      logError: (message, error) => {
        errors.push([message, error instanceof Error ? error.message : error]);
      },
    });

    expect(results).toEqual([{ outcome: 'failed' }, { outcome: 'detected' }]);
    expect(processed).toEqual(['healthy']);
    expect(errors).toEqual([
      ['Carrier bill processing failed for message broken:', 'database unavailable'],
    ]);
  });

  test('names an unidentifiable failed message as unknown', async () => {
    const errors: unknown[] = [];

    const results = await processCarrierBillMessages(db, [null, undefined], {
      processMessage: () => Promise.reject(new Error('boom')),
      logError: (message) => {
        errors.push(message);
      },
    });

    expect(results).toEqual([{ outcome: 'failed' }, { outcome: 'failed' }]);
    expect(errors).toEqual([
      'Carrier bill processing failed for message unknown:',
      'Carrier bill processing failed for message unknown:',
    ]);
  });

  test('processes a mixed batch with the real processor', async () => {
    const message = insertMessage();

    const results = await processCarrierBillMessages(db, [message, null, { id: 'junk' }]);

    expect(results.map((result) => result.outcome)).toEqual(['detected', 'ignored', 'ignored']);
    expect(typeof results[0]?.bill_id).toBe('string');
  });
});
