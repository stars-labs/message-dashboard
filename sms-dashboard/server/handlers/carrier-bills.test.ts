import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createSimsSchema } from '../../test/sims-schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { carrierBillsHandler, deriveBillUrgency } from './carrier-bills.js';

const ADMIN = { id: 'auth0|admin', email: 'admin@example.com' };

interface MutationOptions {
  id?: string;
  body?: unknown;
  rawBody?: string;
  idempotencyKey?: string;
  user?: { id: string } | null;
}

function mutation(
  db: ReturnType<typeof sqliteD1> | Pick<ReturnType<typeof sqliteD1>, 'prepare' | 'batch'>,
  { id, body, rawBody, idempotencyKey, user = ADMIN }: MutationOptions = {},
) {
  const headers = new Headers();
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  const text = rawBody ?? JSON.stringify(body);
  return {
    env: { DB: db },
    ...(user === null ? {} : { user }),
    params: id === undefined ? {} : { id },
    headers,
    text: () => Promise.resolve(text),
  };
}

function listRequest(db: ReturnType<typeof sqliteD1>, query = '') {
  return {
    env: { DB: db },
    url: `https://dashboard.example/api/carrier-bills${query}`,
  };
}

const Record_ = v.record(v.string(), v.unknown());
const BillsBody = v.object({
  success: v.literal(true),
  today: v.string(),
  bills: v.array(v.looseObject({ id: v.string(), urgency: v.string() })),
});
const AccountsBody = v.object({ success: v.literal(true), accounts: v.array(Record_) });
const BillBody = v.looseObject({ bill: Record_ });
const ErrorBody = v.looseObject({ error: v.string() });
const NumberRow = v.object({ n: v.number() });

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

async function bodyOf(response: Response) {
  return v.parse(Record_, await response.json());
}

async function errorOf(response: Response): Promise<string> {
  return v.parse(ErrorBody, await response.json()).error;
}

function count(database: Database, sql: string): number {
  return v.parse(NumberRow, database.query(sql).get()).n;
}

let database: Database;
let db: ReturnType<typeof sqliteD1>;

beforeEach(async () => {
  database = new Database(':memory:');
  await createSimsSchema(database);
  database.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp TIMESTAMP,
      type TEXT
    );
    INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier) VALUES
      ('notification-sim', 79, '+6590000079', 'SG', 'Singtel'),
      ('linked-sim', 80, '+6590000080', 'SG', 'Singtel'),
      ('m1-sim', 81, '+6590000081', 'SG', 'M1');
    INSERT INTO messages VALUES (
      'message-1', 'notification-sim', 'Singtel', 'retained bill source',
      '2026-08-20T00:00:00Z', 'received'
    );
  `);
  for (const name of [
    '066_add_carrier_billing.sql',
    '067_add_carrier_billing_account_events.sql',
  ]) {
    database.run(await Bun.file(new URL(`../../migrations/${name}`, import.meta.url)).text());
  }
  database.run(`
    INSERT INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES
      ('account-1', 'SG', 'Singtel', 'SGD', 'Singtel corporate',
       'notification-sim', '${'a'.repeat(64)}', '5678', 'active', 'auth0|admin'),
      ('account-2', 'SG', 'M1', 'SGD', 'M1 corporate',
       'm1-sim', '${'b'.repeat(64)}', '1111', 'pending_verification', 'auth0|admin');
    INSERT INTO carrier_billing_account_sims (
      billing_account_id, sim_iccid, verification_source, verified_at, verified_by
    ) VALUES
      ('account-1', 'notification-sim', 'contract_or_bill', '2026-08-01', 'auth0|admin'),
      ('account-1', 'linked-sim', 'carrier_account', '2026-08-01', 'auth0|admin'),
      ('account-2', 'm1-sim', 'contract_or_bill', '2026-08-01', 'auth0|admin');
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
  db = sqliteD1(database);
});

function insertBill(
  id: string,
  dueDate: string,
  status: 'unpaid' | 'paid' | 'waived' | 'needs_review' = 'unpaid',
  accountId = 'account-2',
) {
  database
    .query(
      `
    INSERT INTO carrier_bills (
      id, billing_account_id, amount_minor, currency, due_date, received_at,
      parser_version, action_status, paid_at, paid_by
    ) VALUES (?, ?, 1000, 'SGD', ?, '2026-08-01T00:00:00Z', 'test-v1', ?,
      CASE WHEN ? = 'paid' THEN '2026-08-02T00:00:00Z' END,
      CASE WHEN ? = 'paid' THEN 'auth0|admin' END)
  `,
    )
    .run(id, accountId, dueDate, status, status, status);
}

describe('carrier bill urgency', () => {
  test.each([
    ['unpaid', '2026-09-09', '2026-09-01', 'open', 8],
    ['unpaid', '2026-09-08', '2026-09-01', 'due_soon', 7],
    ['payment_planned', '2026-09-01', '2026-09-01', 'due_soon', 0],
    ['payment_planned', '2026-08-31', '2026-09-01', 'overdue', -1],
    ['paid', '2026-08-31', '2026-09-01', 'paid', -1],
    ['waived', '2026-08-31', '2026-09-01', 'waived', -1],
    ['needs_review', '2026-09-30', '2026-09-01', 'needs_review', 29],
  ] as const)('derives %s / %s as %s', (actionStatus, dueDate, today, urgency, daysRemaining) => {
    expect(deriveBillUrgency({ action_status: actionStatus, due_date: dueDate }, today)).toEqual({
      urgency,
      days_remaining: daysRemaining,
    });
  });
});

describe('carrier bills API', () => {
  test('lists account-level bills with linked SIM and notification details', async () => {
    const response = await carrierBillsHandler.list(listRequest(db), { today: '2026-09-10' });
    const body = v.parse(BillsBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.today).toBe('2026-09-10');
    expect(body.bills).toHaveLength(1);
    expect(body.bills[0]).toEqual({
      id: 'bill-1',
      billing_account_id: 'account-1',
      source_message_id: 'message-1',
      amount_minor: 4280,
      currency: 'SGD',
      due_date: '2026-09-14',
      received_at: '2026-08-20T00:00:00Z',
      parser_version: 'sg-singtel-postpaid-bill-sms-v1',
      action_status: 'unpaid',
      payment_planned_at: null,
      paid_at: null,
      paid_by: null,
      operator_note: null,
      version: 1,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      account_display_name: 'Singtel corporate',
      carrier: 'Singtel',
      notification_sim_iccid: 'notification-sim',
      linked_sim_count: 2,
      account_ref_masked: '•••• 5678',
      notification_sim: { iccid: 'notification-sim', sim_index: 79, number: '+6590000079' },
      urgency: 'due_soon',
      days_remaining: 4,
    });
  });

  test('orders bills by urgency, then due date, then id', async () => {
    insertBill('bill-paid', '2026-08-01', 'paid');
    insertBill('bill-review', '2026-10-01', 'needs_review');
    insertBill('bill-overdue', '2026-09-01');
    insertBill('bill-open', '2026-12-01');
    insertBill('bill-waived', '2026-07-01', 'waived');

    const response = await carrierBillsHandler.list(listRequest(db), { today: '2026-09-10' });
    const body = v.parse(BillsBody, await response.json());

    expect(body.bills.map((bill) => [bill.id, bill.urgency])).toEqual([
      ['bill-review', 'needs_review'],
      ['bill-overdue', 'overdue'],
      ['bill-1', 'due_soon'],
      ['bill-open', 'open'],
      ['bill-paid', 'paid'],
      ['bill-waived', 'waived'],
    ]);
  });

  test('filters by carrier, account, due date range and status', async () => {
    insertBill('bill-paid', '2026-08-01', 'paid');
    insertBill('bill-overdue', '2026-09-01');
    const ids = async (query: string) =>
      v
        .parse(BillsBody, await (await carrierBillsHandler.list(listRequest(db, query))).json())
        .bills.map((bill) => bill.id);

    expect(await ids('?carrier=M1')).toEqual(['bill-overdue', 'bill-paid']);
    expect(await ids('?account_id=account-1')).toEqual(['bill-1']);
    expect(await ids('?from=2026-09-01')).toEqual(['bill-overdue', 'bill-1']);
    expect(await ids('?to=2026-08-31')).toEqual(['bill-paid']);
    expect(await ids('?from=2026-09-01&to=2026-09-01')).toEqual(['bill-overdue']);
    expect(await ids('?status=paid')).toEqual(['bill-paid']);
    expect(await ids('?status=unpaid')).toEqual(['bill-overdue', 'bill-1']);
    expect(await ids('?carrier=Nobody')).toEqual([]);
    expect(await ids('?to=2024-02-29')).toEqual([]);
  });

  test('answers 400 for a from or to that is not an ISO date', async () => {
    for (const [query, error] of [
      ['?from=yesterday', 'from must be an ISO date'],
      ['?from=2026-13-01', 'from must be an ISO date'],
      ['?to=2026-9-1', 'to must be an ISO date'],
      ['?to=2026-02-30', 'to must be an ISO date'],
      ['?to=2026-00-10', 'to must be an ISO date'],
    ]) {
      const response = await carrierBillsHandler.list(listRequest(db, query));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
  });

  test('lists billing accounts and their explicitly verified SIM memberships', async () => {
    const response = await carrierBillsHandler.listAccounts({ env: { DB: db } });
    const body = v.parse(AccountsBody, await response.json());

    expect(body.accounts).toEqual([
      {
        id: 'account-2',
        country_code: 'SG',
        carrier: 'M1',
        currency: 'SGD',
        display_name: 'M1 corporate',
        account_ref_masked: '•••• 1111',
        status: 'pending_verification',
        version: 1,
        payment_due_count: 0,
        notification_sim: { iccid: 'm1-sim', sim_index: 81, number: '+6590000081' },
        linked_sims: [
          {
            iccid: 'm1-sim',
            sim_index: 81,
            number: '+6590000081',
            verification_source: 'contract_or_bill',
            verified_at: '2026-08-01',
            verified_by: 'auth0|admin',
          },
        ],
      },
      {
        id: 'account-1',
        country_code: 'SG',
        carrier: 'Singtel',
        currency: 'SGD',
        display_name: 'Singtel corporate',
        account_ref_masked: '•••• 5678',
        status: 'active',
        version: 1,
        payment_due_count: 1,
        notification_sim: { iccid: 'notification-sim', sim_index: 79, number: '+6590000079' },
        linked_sims: [
          {
            iccid: 'notification-sim',
            sim_index: 79,
            number: '+6590000079',
            verification_source: 'contract_or_bill',
            verified_at: '2026-08-01',
            verified_by: 'auth0|admin',
          },
          {
            iccid: 'linked-sim',
            sim_index: 80,
            number: '+6590000080',
            verification_source: 'carrier_account',
            verified_at: '2026-08-01',
            verified_by: 'auth0|admin',
          },
        ],
      },
    ]);
  });

  test('leaves removed members out of the account lists and the linked SIM count', async () => {
    database.run(
      `UPDATE carrier_billing_account_sims SET removed_at = '2026-08-15' WHERE sim_iccid = 'linked-sim'`,
    );

    const accounts = v.parse(
      AccountsBody,
      await (await carrierBillsHandler.listAccounts({ env: { DB: db } })).json(),
    );
    const bills = v.parse(
      BillsBody,
      await (await carrierBillsHandler.list(listRequest(db))).json(),
    );

    expect(accounts.accounts.map((account) => account['linked_sims'])).toEqual([
      [expect.objectContaining({ iccid: 'm1-sim' })],
      [expect.objectContaining({ iccid: 'notification-sim' })],
    ]);
    expect(bills.bills[0]).toMatchObject({ linked_sim_count: 1 });
  });

  test('returns bill detail with retained source evidence and immutable events', async () => {
    const response = await carrierBillsHandler.get(
      { env: { DB: db }, params: { id: 'bill-1' } },
      { today: '2026-08-24' },
    );
    const body = v.parse(BillBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.bill['source_message']).toEqual({
      id: 'message-1',
      sender: 'Singtel',
      content: 'retained bill source',
      timestamp: '2026-08-20T00:00:00Z',
    });
    expect(body.bill['linked_sims']).toEqual([
      expect.objectContaining({ iccid: 'notification-sim', sim_index: 79 }),
      expect.objectContaining({ iccid: 'linked-sim', sim_index: 80 }),
    ]);
    const events = v.parse(v.array(Record_), body.bill['events']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'event-1',
      event_type: 'detected',
      actor_type: 'system',
      actor_subject: null,
      source_message_id: 'message-1',
      metadata: { source: 'sms' },
    });
    expect(events[0]).not.toHaveProperty('metadata_json');
    expect(body.bill).toMatchObject({ urgency: 'open', days_remaining: 21 });
    expect(body.bill).not.toHaveProperty('account_ref_last4');
  });

  test('returns null source evidence when the bill has no retained message', async () => {
    insertBill('bill-bare', '2026-10-01');

    const response = await carrierBillsHandler.get({
      env: { DB: db },
      params: { id: 'bill-bare' },
    });
    const body = v.parse(BillBody, await response.json());

    expect(body.bill['source_message']).toBeNull();
  });

  test('keeps a JSON object or array in event metadata and shows {} for any other value', async () => {
    database.run(`
      INSERT INTO carrier_bill_events (id, bill_id, event_type, actor_type, metadata_json) VALUES
        ('event-2', 'bill-1', 'parse_conflict', 'system', '[1,2]'),
        ('event-3', 'bill-1', 'duplicate_detected', 'system', '"text"'),
        ('event-4', 'bill-1', 'paid', 'system', 'null'),
        ('event-5', 'bill-1', 'waived', 'system', '5')
    `);

    const response = await carrierBillsHandler.get({ env: { DB: db }, params: { id: 'bill-1' } });
    const body = v.parse(BillBody, await response.json());
    const metadata = v
      .parse(v.array(v.looseObject({ id: v.string(), metadata: v.unknown() })), body.bill['events'])
      .map((event) => [event.id, event.metadata]);

    expect(metadata).toEqual([
      ['event-1', { source: 'sms' }],
      ['event-2', [1, 2]],
      ['event-3', {}],
      ['event-4', {}],
      ['event-5', {}],
    ]);
  });

  test('answers 404 for a bill that does not exist', async () => {
    const response = await carrierBillsHandler.get({ env: { DB: db }, params: { id: 'nope' } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Bill not found' });
  });

  test('records a payment plan with optimistic concurrency and user audit', async () => {
    const response = await carrierBillsHandler.paymentPlanned(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 1, note: 'Pay on Friday' },
        idempotencyKey: 'plan-bill-1-v1',
      }),
    );
    const body = v.parse(BillBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.bill).toMatchObject({
      action_status: 'payment_planned',
      version: 2,
      operator_note: 'Pay on Friday',
    });
    expect(body.bill['payment_planned_at']).toEqual(expect.any(String));
    expect(
      database
        .query(
          `
      SELECT event_type, actor_type, actor_subject, idempotency_key, metadata_json
      FROM carrier_bill_events WHERE event_type = 'payment_planned'
    `,
        )
        .get(),
    ).toEqual({
      event_type: 'payment_planned',
      actor_type: 'user',
      actor_subject: 'auth0|admin',
      idempotency_key: 'plan-bill-1-v1',
      metadata_json: '{"from":"unpaid","to":"payment_planned","note":"Pay on Friday"}',
    });
  });

  test('marks a bill paid by the actor, waives it, and reopens it', async () => {
    const paid = v.parse(
      BillBody,
      await (
        await carrierBillsHandler.markPaid(
          mutation(db, { id: 'bill-1', body: { expected_version: 1 }, idempotencyKey: 'k1' }),
        )
      ).json(),
    );
    expect(paid.bill).toMatchObject({
      action_status: 'paid',
      paid_by: 'auth0|admin',
      payment_planned_at: null,
      version: 2,
    });
    expect(paid.bill['paid_at']).toEqual(expect.any(String));

    const waived = v.parse(
      BillBody,
      await (
        await carrierBillsHandler.waive(
          mutation(db, { id: 'bill-1', body: { expected_version: 2 }, idempotencyKey: 'k2' }),
        )
      ).json(),
    );
    expect(waived.bill).toMatchObject({
      action_status: 'waived',
      paid_at: null,
      paid_by: null,
      version: 3,
    });

    const reopened = v.parse(
      BillBody,
      await (
        await carrierBillsHandler.reopen(
          mutation(db, { id: 'bill-1', body: { expected_version: 3 }, idempotencyKey: 'k3' }),
        )
      ).json(),
    );
    expect(reopened.bill).toMatchObject({ action_status: 'unpaid', version: 4 });
    expect(
      database
        .query(
          `SELECT event_type FROM carrier_bill_events WHERE actor_type = 'user' ORDER BY rowid`,
        )
        .all(),
    ).toEqual([{ event_type: 'paid' }, { event_type: 'waived' }, { event_type: 'reopened' }]);
  });

  test('trims the note, ignores a blank one, and keeps the earlier note', async () => {
    await carrierBillsHandler.paymentPlanned(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 1, note: '  Pay later  ' },
        idempotencyKey: 'k1',
      }),
    );
    await carrierBillsHandler.markPaid(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 2, note: '   ' },
        idempotencyKey: 'k2',
      }),
    );

    expect(database.query(`SELECT operator_note, version FROM carrier_bills`).get()).toEqual({
      operator_note: 'Pay later',
      version: 3,
    });
    expect(
      database
        .query(`SELECT metadata_json FROM carrier_bill_events WHERE event_type = 'paid'`)
        .get(),
    ).toEqual({ metadata_json: '{"from":"payment_planned","to":"paid","note":null}' });
  });

  test('accepts a note of 1000 characters after trimming and rejects a longer one', async () => {
    const ok = await carrierBillsHandler.paymentPlanned(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 1, note: ` ${'x'.repeat(1000)} ` },
        idempotencyKey: 'k1',
      }),
    );
    const tooLong = await carrierBillsHandler.markPaid(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 2, note: 'x'.repeat(1001) },
        idempotencyKey: 'k2',
      }),
    );

    expect(ok.status).toBe(200);
    expect(tooLong.status).toBe(400);
    expect(await errorOf(tooLong)).toBe('note must be a string of at most 1000 characters');
  });

  test('returns the prior result when the same idempotency key is retried', async () => {
    const actionRequest = () =>
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 1 },
        idempotencyKey: 'paid-bill-1-v1',
      });
    await carrierBillsHandler.markPaid(actionRequest());
    const retry = await carrierBillsHandler.markPaid(actionRequest());
    const body = await bodyOf(retry);

    expect(retry.status).toBe(200);
    expect(body['idempotent']).toBe(true);
    expect(v.parse(Record_, body['bill'])).toMatchObject({
      action_status: 'paid',
      version: 2,
      paid_by: 'auth0|admin',
    });
    expect(
      count(database, `SELECT COUNT(*) AS n FROM carrier_bill_events WHERE event_type = 'paid'`),
    ).toBe(1);
  });

  test('answers 409 when the idempotency key was used for another bill', async () => {
    insertBill('bill-2', '2026-10-01');
    await carrierBillsHandler.markPaid(
      mutation(db, { id: 'bill-2', body: { expected_version: 1 }, idempotencyKey: 'shared' }),
    );

    const response = await carrierBillsHandler.markPaid(
      mutation(db, { id: 'bill-1', body: { expected_version: 1 }, idempotencyKey: 'shared' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Idempotency key was already used for another bill',
    });
  });

  test('rejects stale versions and missing idempotency keys without mutation', async () => {
    const stale = await carrierBillsHandler.waive(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 99 },
        idempotencyKey: 'waive-stale',
      }),
    );
    const missingKey = await carrierBillsHandler.waive(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 1 },
      }),
    );

    expect(stale.status).toBe(409);
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({
      error: 'A bounded Idempotency-Key header is required',
    });
    expect(database.query(`SELECT action_status, version FROM carrier_bills`).get()).toEqual({
      action_status: 'unpaid',
      version: 1,
    });
  });

  test('a stale version answers 409 with the current version and bill', async () => {
    const response = await carrierBillsHandler.waive(
      mutation(db, { id: 'bill-1', body: { expected_version: 99 }, idempotencyKey: 'stale' }),
    );
    const body = await bodyOf(response);

    expect(body['error']).toBe('Bill version conflict');
    expect(body['current_version']).toBe(1);
    const bill = v.parse(Record_, body['bill']);
    expect(bill).toMatchObject({ id: 'bill-1', version: 1, action_status: 'unpaid' });
    expect(bill).toHaveProperty('urgency');
  });

  test('answers 400 for an idempotency key that is empty or longer than 200 characters', async () => {
    for (const idempotencyKey of ['   ', 'k'.repeat(201)]) {
      const response = await carrierBillsHandler.waive(
        mutation(db, { id: 'bill-1', body: { expected_version: 1 }, idempotencyKey }),
      );
      expect(response.status).toBe(400);
    }
    const longest = await carrierBillsHandler.waive(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 1 },
        idempotencyKey: 'k'.repeat(200),
      }),
    );
    expect(longest.status).toBe(200);
  });

  test('answers 400 without a bill id and 401 without an actor', async () => {
    const noId = await carrierBillsHandler.waive(
      mutation(db, { body: { expected_version: 1 }, idempotencyKey: 'k' }),
    );
    const noActor = await carrierBillsHandler.waive(
      mutation(db, {
        id: 'bill-1',
        body: { expected_version: 1 },
        idempotencyKey: 'k',
        user: null,
      }),
    );

    expect(noId.status).toBe(400);
    expect(await noId.json()).toEqual({ error: 'Missing bill id' });
    expect(noActor.status).toBe(401);
    expect(await noActor.json()).toEqual({ error: 'Unauthorized' });
  });

  test('answers 400 for a body that is not JSON', async () => {
    const response = await carrierBillsHandler.waive(
      mutation(db, { id: 'bill-1', rawBody: 'not json', idempotencyKey: 'k' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Body must be JSON' });
  });

  test('answers 400 unless expected_version is a positive integer', async () => {
    for (const body of [
      {},
      null,
      [],
      'text',
      { expected_version: 0 },
      { expected_version: -1 },
      { expected_version: 1.5 },
      { expected_version: '1' },
      { expected_version: null },
    ]) {
      const response = await carrierBillsHandler.waive(
        mutation(db, { id: 'bill-1', body, idempotencyKey: 'k' }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('expected_version must be a positive integer');
    }
  });

  test('answers 400 for a note that is not a string', async () => {
    for (const note of [5, true, { text: 'x' }, ['x']]) {
      const response = await carrierBillsHandler.waive(
        mutation(db, { id: 'bill-1', body: { expected_version: 1, note }, idempotencyKey: 'k' }),
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('note must be a string of at most 1000 characters');
    }
  });

  test('reports the version error before the note error', async () => {
    const response = await carrierBillsHandler.waive(
      mutation(db, { id: 'bill-1', body: { expected_version: 0, note: 5 }, idempotencyKey: 'k' }),
    );

    expect(await errorOf(response)).toBe('expected_version must be a positive integer');
  });

  test('answers 404 for a bill that does not exist', async () => {
    const response = await carrierBillsHandler.waive(
      mutation(db, { id: 'nope', body: { expected_version: 1 }, idempotencyKey: 'k' }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Bill not found' });
  });

  test('answers 409 with the latest bill when another writer changes it during the update', async () => {
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (statements: Parameters<typeof db.batch>[0]) => {
        database.run(`UPDATE carrier_bills SET version = 5 WHERE id = 'bill-1'`);
        return db.batch(statements);
      },
    };

    const response = await carrierBillsHandler.waive(
      mutation(racing, { id: 'bill-1', body: { expected_version: 1 }, idempotencyKey: 'k' }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(409);
    expect(body['error']).toBe('Bill version conflict');
    expect(body['current_version']).toBe(5);
    expect(v.parse(Record_, body['bill'])).toMatchObject({ id: 'bill-1', version: 5 });
    expect(
      count(database, `SELECT COUNT(*) AS n FROM carrier_bill_events WHERE actor_type = 'user'`),
    ).toBe(0);
  });

  test('returns the stored result when a concurrent request stored the same key first', async () => {
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (statements: Parameters<typeof db.batch>[0]) => {
        database.run(`
          INSERT INTO carrier_bill_events (id, bill_id, event_type, actor_type, actor_subject, idempotency_key)
          VALUES ('raced', 'bill-1', 'waived', 'user', 'auth0|admin', 'k')
        `);
        return db.batch(statements);
      },
    };

    const response = await carrierBillsHandler.waive(
      mutation(racing, { id: 'bill-1', body: { expected_version: 1 }, idempotencyKey: 'k' }),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body['idempotent']).toBe(true);
    expect(v.parse(Record_, body['bill'])).toMatchObject({ id: 'bill-1', version: 1 });
  });

  test('rethrows a batch failure that is not a concurrent request for the same bill', async () => {
    const failing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: () => Promise.reject(new Error('D1 is down')),
    };

    const error = await failure(
      carrierBillsHandler.waive(
        mutation(failing, { id: 'bill-1', body: { expected_version: 1 }, idempotencyKey: 'k' }),
      ),
    );

    expect(error.message).toBe('D1 is down');
  });

  test('a bill row that does not match the schema fails the request', async () => {
    database.run(`PRAGMA ignore_check_constraints = ON`);
    database.run(`UPDATE carrier_bills SET action_status = 'lost' WHERE id = 'bill-1'`);

    const error = await failure(carrierBillsHandler.list(listRequest(db)));

    expect(error.message).toContain('"lost"');
  });
});
