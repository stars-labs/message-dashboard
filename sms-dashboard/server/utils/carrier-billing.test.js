import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  processCarrierBillMessages,
  processCarrierBillMessage,
  reconcileCarrierBillMessages,
} from './carrier-billing.js';

const ACCOUNT_REFERENCE = '12345678';

function billMessage({ amount = '42.80', dueDate = '14 Sep 2026' } = {}) {
  return `<Singtel>Dear customer, your latest bill for Singtel a/c ${ACCOUNT_REFERENCE} is ready. The total amount is SGD$${amount} due on ${dueDate}. You can view and pay this bill via My Singtel app at www.singtel.com/viewbill .@`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function d1(database) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              return database.query(sql).get(...params) ?? null;
            },
            async all() {
              return { results: database.query(sql).all(...params) };
            },
            async run() {
              const result = database.query(sql).run(...params);
              return { meta: { changes: result.changes } };
            },
          };
        },
      };
    },
  };
}

let database;
let db;

beforeEach(async () => {
  database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (
      iccid TEXT PRIMARY KEY,
      service_type TEXT NOT NULL,
      country_code TEXT,
      carrier TEXT
    );
    CREATE VIEW device_view AS
      SELECT iccid, service_type, country_code AS country, carrier FROM sims;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT NOT NULL,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL
    );
    INSERT INTO sims VALUES
      ('notification-sim', 'postpaid', 'SG', 'Singtel'),
      ('prepaid-sim', 'prepaid', 'SG', 'Singtel'),
      ('wrong-carrier', 'postpaid', 'SG', 'StarHub');
  `);
  const migration = await Bun.file(
    new URL('../../migrations/066_add_carrier_billing.sql', import.meta.url),
  ).text();
  database.exec(migration);
  database.query(`
    INSERT INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES ('account-1', 'SG', 'Singtel', 'SGD', 'Singtel account',
      'notification-sim', ?, '5678', 'active', 'auth0|admin')
  `).run(await sha256(ACCOUNT_REFERENCE));
  db = d1(database);
});

function insertMessage({
  id = 'message-1',
  iccid = 'notification-sim',
  sender = 'Singtel',
  content = billMessage(),
  timestamp = '2026-08-24T01:02:03Z',
  type = 'received',
} = {}) {
  database.query(`
    INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, iccid, sender, content, timestamp, type);
  return { id, phone_iccid: iccid, phone_number: sender, content, timestamp, type };
}

function bills() {
  return database.query(`
    SELECT billing_account_id, source_message_id, amount_minor, currency,
      due_date, action_status, version
    FROM carrier_bills ORDER BY due_date
  `).all();
}

function events() {
  return database.query(`
    SELECT event_type, source_message_id FROM carrier_bill_events
    ORDER BY event_type, source_message_id
  `).all();
}

describe('carrier bill SMS processing', () => {
  test('creates one normalized bill and a detected event', async () => {
    const result = await processCarrierBillMessage(db, insertMessage());

    expect(result).toMatchObject({ outcome: 'detected', bill_id: expect.any(String) });
    expect(bills()).toEqual([{
      billing_account_id: 'account-1',
      source_message_id: 'message-1',
      amount_minor: 4280,
      currency: 'SGD',
      due_date: '2026-09-14',
      action_status: 'unpaid',
      version: 1,
    }]);
    expect(events()).toEqual([{ event_type: 'detected', source_message_id: 'message-1' }]);
  });

  test('is idempotent when the same source message is retried', async () => {
    const message = insertMessage();
    await processCarrierBillMessage(db, message);
    const retry = await processCarrierBillMessage(db, message);

    expect(retry.outcome).toBe('already_processed');
    expect(bills()).toHaveLength(1);
    expect(events()).toHaveLength(1);
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
    ['wrong sender', { sender: 'Singtel Biz' }],
    ['wrong message type', { type: 'sent' }],
    ['unsupported content', { content: 'Your bill is ready.' }],
  ])('rejects %s', async (_name, overrides) => {
    const result = await processCarrierBillMessage(db, insertMessage(overrides));

    expect(result.outcome).toBe('ignored');
    expect(bills()).toEqual([]);
  });

  test('rejects an account whose notification SIM inventory is no longer eligible', async () => {
    const message = insertMessage();
    database.query(`UPDATE sims SET service_type = 'prepaid' WHERE iccid = 'notification-sim'`).run();

    expect(await processCarrierBillMessage(db, message)).toEqual({ outcome: 'ignored' });
    expect(bills()).toEqual([]);
  });

  test('scheduled reconciliation recovers eligible missed messages', async () => {
    insertMessage({ id: 'message-1' });
    insertMessage({ id: 'message-2', content: 'Not a bill' });

    const result = await reconcileCarrierBillMessages(db);

    expect(result).toEqual({ scanned: 1, detected: 1, remaining: 0 });
    expect(bills()).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });

  test('isolates one processing failure from the rest of an upload batch', async () => {
    const errors = [];
    const processed = [];
    const processMessage = async (_database, message) => {
      if (message.id === 'broken') throw new Error('database unavailable');
      processed.push(message.id);
      return { outcome: 'detected' };
    };

    const results = await processCarrierBillMessages(db, [
      { id: 'broken' },
      { id: 'healthy' },
    ], {
      processMessage,
      logError: (message, error) => errors.push([message, error.message]),
    });

    expect(results).toEqual([
      { outcome: 'failed' },
      { outcome: 'detected' },
    ]);
    expect(processed).toEqual(['healthy']);
    expect(errors).toEqual([[
      'Carrier bill processing failed for message broken:',
      'database unavailable',
    ]]);
  });
});
