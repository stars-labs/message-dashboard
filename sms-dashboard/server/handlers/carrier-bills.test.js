import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  carrierBillsHandler,
  deriveBillUrgency,
} from './carrier-bills.js';

function d1(database) {
  const bound = (sql, params) => ({
    sql,
    params,
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
  });

  return {
    prepare(sql) {
      return { bind: (...params) => bound(sql, params) };
    },
    async batch(statements) {
      return database.transaction(() => statements.map((statement) => {
        const result = database.query(statement.sql).run(...statement.params);
        return { meta: { changes: result.changes } };
      }))();
    },
  };
}

function request(db, {
  url = 'https://dashboard.example/api/carrier-bills',
  id,
  body,
  idempotencyKey,
  user = { id: 'auth0|admin', email: 'admin@example.com' },
} = {}) {
  const headers = new Headers();
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  return {
    env: { DB: db },
    user,
    params: id ? { id } : {},
    url,
    headers,
    json: async () => body,
  };
}

async function json(response) {
  return response.json();
}

let database;
let db;

beforeEach(async () => {
  database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (
      iccid TEXT PRIMARY KEY,
      sim_index INTEGER,
      phone_number TEXT,
      service_type TEXT NOT NULL,
      country_code TEXT,
      carrier TEXT
    );
    CREATE VIEW device_view AS SELECT
      iccid,
      sim_index,
      phone_number AS number,
      service_type,
      country_code AS country,
      carrier
    FROM sims;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp TEXT,
      type TEXT
    );
    INSERT INTO sims VALUES
      ('notification-sim', 79, '+6590000079', 'postpaid', 'SG', 'Singtel'),
      ('linked-sim', 80, '+6590000080', 'postpaid', 'SG', 'Singtel');
    INSERT INTO messages VALUES (
      'message-1', 'notification-sim', 'Singtel', 'retained bill source',
      '2026-08-20T00:00:00Z', 'received'
    );
  `);
  for (const name of ['066_add_carrier_billing.sql', '067_add_carrier_billing_account_events.sql']) {
    const migration = await Bun.file(new URL(`../../migrations/${name}`, import.meta.url)).text();
    database.exec(migration);
  }
  database.exec(`
    INSERT INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES (
      'account-1', 'SG', 'Singtel', 'SGD', 'Singtel corporate',
      'notification-sim', '${'a'.repeat(64)}', '5678', 'active', 'auth0|admin'
    );
    INSERT INTO carrier_billing_account_sims (
      billing_account_id, sim_iccid, verification_source, verified_at, verified_by
    ) VALUES
      ('account-1', 'notification-sim', 'contract_or_bill', '2026-08-01', 'auth0|admin'),
      ('account-1', 'linked-sim', 'contract_or_bill', '2026-08-01', 'auth0|admin');
    INSERT INTO carrier_bills (
      id, billing_account_id, source_message_id, amount_minor, currency,
      due_date, received_at, parser_version
    ) VALUES (
      'bill-1', 'account-1', 'message-1', 4280, 'SGD', '2026-09-14',
      '2026-08-20T00:00:00Z', 'sg-singtel-postpaid-bill-sms-v1'
    );
    INSERT INTO carrier_bill_events (
      id, bill_id, event_type, actor_type, source_message_id, metadata_json
    ) VALUES ('event-1', 'bill-1', 'detected', 'system', 'message-1', '{"source":"sms"}');
  `);
  db = d1(database);
});

describe('carrier bill urgency', () => {
  test.each([
    ['unpaid', '2026-09-09', '2026-09-01', 'open', 8],
    ['unpaid', '2026-09-08', '2026-09-01', 'due_soon', 7],
    ['payment_planned', '2026-09-01', '2026-09-01', 'due_soon', 0],
    ['payment_planned', '2026-08-31', '2026-09-01', 'overdue', -1],
    ['paid', '2026-08-31', '2026-09-01', 'paid', -1],
    ['waived', '2026-08-31', '2026-09-01', 'waived', -1],
    ['needs_review', '2026-09-30', '2026-09-01', 'needs_review', 29],
  ])('derives %s / %s as %s', (actionStatus, dueDate, today, urgency, daysRemaining) => {
    expect(deriveBillUrgency({ action_status: actionStatus, due_date: dueDate }, today))
      .toEqual({ urgency, days_remaining: daysRemaining });
  });
});

describe('carrier bills API', () => {
  test('lists account-level bills with linked SIM and notification details', async () => {
    const response = await carrierBillsHandler.list(request(db), { today: '2026-09-10' });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.bills).toHaveLength(1);
    expect(body.bills[0]).toMatchObject({
      id: 'bill-1',
      billing_account_id: 'account-1',
      account_ref_masked: '•••• 5678',
      amount_minor: 4280,
      linked_sim_count: 2,
      notification_sim: { iccid: 'notification-sim', sim_index: 79 },
      urgency: 'due_soon',
      days_remaining: 4,
    });
  });

  test('lists billing accounts and their explicitly verified SIM memberships', async () => {
    const response = await carrierBillsHandler.listAccounts(request(db));
    const body = await json(response);

    expect(body.accounts).toEqual([expect.objectContaining({
      id: 'account-1',
      account_ref_masked: '•••• 5678',
      notification_sim: expect.objectContaining({ sim_index: 79 }),
      linked_sims: [
        expect.objectContaining({ iccid: 'notification-sim', sim_index: 79 }),
        expect.objectContaining({ iccid: 'linked-sim', sim_index: 80 }),
      ],
    })]);
  });

  test('returns bill detail with retained source evidence and immutable events', async () => {
    const response = await carrierBillsHandler.get(request(db, { id: 'bill-1' }), {
      today: '2026-08-24',
    });
    const body = await json(response);

    expect(body.bill.source_message).toEqual({
      id: 'message-1',
      sender: 'Singtel',
      content: 'retained bill source',
      timestamp: '2026-08-20T00:00:00Z',
    });
    expect(body.bill.linked_sims).toHaveLength(2);
    expect(body.bill.events).toEqual([expect.objectContaining({ event_type: 'detected' })]);
  });

  test('records a payment plan with optimistic concurrency and user audit', async () => {
    const response = await carrierBillsHandler.paymentPlanned(request(db, {
      id: 'bill-1',
      body: { expected_version: 1, note: 'Pay on Friday' },
      idempotencyKey: 'plan-bill-1-v1',
    }));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.bill).toMatchObject({ action_status: 'payment_planned', version: 2 });
    expect(database.query(`
      SELECT event_type, actor_type, actor_subject, idempotency_key
      FROM carrier_bill_events WHERE event_type = 'payment_planned'
    `).get()).toEqual({
      event_type: 'payment_planned',
      actor_type: 'user',
      actor_subject: 'auth0|admin',
      idempotency_key: 'plan-bill-1-v1',
    });
  });

  test('returns the prior result when the same idempotency key is retried', async () => {
    const actionRequest = () => request(db, {
      id: 'bill-1',
      body: { expected_version: 1 },
      idempotencyKey: 'paid-bill-1-v1',
    });
    await carrierBillsHandler.markPaid(actionRequest());
    const retry = await carrierBillsHandler.markPaid(actionRequest());
    const body = await json(retry);

    expect(retry.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.bill).toMatchObject({ action_status: 'paid', version: 2, paid_by: 'auth0|admin' });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM carrier_bill_events WHERE event_type = 'paid'
    `).get().count).toBe(1);
  });

  test('rejects stale versions and missing idempotency keys without mutation', async () => {
    const stale = await carrierBillsHandler.waive(request(db, {
      id: 'bill-1',
      body: { expected_version: 99 },
      idempotencyKey: 'waive-stale',
    }));
    const missingKey = await carrierBillsHandler.waive(request(db, {
      id: 'bill-1',
      body: { expected_version: 1 },
    }));

    expect(stale.status).toBe(409);
    expect(missingKey.status).toBe(400);
    expect(database.query(`SELECT action_status, version FROM carrier_bills`).get())
      .toEqual({ action_status: 'unpaid', version: 1 });
  });

  test('reopens a resolved bill and clears resolution fields', async () => {
    await carrierBillsHandler.markPaid(request(db, {
      id: 'bill-1',
      body: { expected_version: 1 },
      idempotencyKey: 'paid-first',
    }));
    const response = await carrierBillsHandler.reopen(request(db, {
      id: 'bill-1',
      body: { expected_version: 2, note: 'Payment was reversed' },
      idempotencyKey: 'reopen-paid',
    }));
    const body = await json(response);

    expect(body.bill).toMatchObject({
      action_status: 'unpaid',
      paid_at: null,
      paid_by: null,
      payment_planned_at: null,
      version: 3,
    });
  });
});
