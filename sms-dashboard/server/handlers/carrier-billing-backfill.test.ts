import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createSimsSchema } from '../../test/sims-schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1 } from '../lib/d1.js';
import { previewCarrierBillBackfill } from '../utils/carrier-billing-backfill.js';
import { carrierBillingBackfillHandler } from './carrier-billing-backfill.js';

const ACCOUNT_REFERENCE = '12345678';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const MALFORMED_BODY = 'expected_version must be an integer and preview_digest a string';

function billMessage(index: number): string {
  const amount = `${String(40 + index)}.${String(index).padStart(2, '0')}`;
  return `<Singtel>Dear customer, your latest bill for Singtel a/c ${ACCOUNT_REFERENCE} is ready. The total amount is SGD$${amount} due on 14 ${MONTHS[index] ?? ''} 2026. You can view and pay this bill via My Singtel app at www.singtel.com/viewbill .@`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface RequestOptions {
  key?: string | null;
  user?: { id: string } | null;
}

function rawRequest(
  binding: D1,
  text: string,
  { key = 'backfill-execute', user = { id: 'auth0|admin' } }: RequestOptions = {},
) {
  return {
    env: { DB: binding },
    ...(user === null ? {} : { user }),
    headers: new Headers(key === null ? {} : { 'Idempotency-Key': key }),
    text: () => Promise.resolve(text),
  };
}

function bodyRequest(binding: D1, body: unknown, options?: RequestOptions) {
  return rawRequest(binding, JSON.stringify(body), options);
}

const Record_ = v.record(v.string(), v.unknown());
const Counts = v.object({
  detected: v.number(),
  duplicate_detected: v.number(),
  parse_conflict: v.number(),
  already_processed: v.number(),
});
const PreviewBody = v.object({
  success: v.literal(true),
  account: v.object({ version: v.number() }),
  summary: Record_,
  preview_digest: v.string(),
  candidates: v.array(Record_),
});
const ExecuteBody = v.looseObject({
  success: v.literal(true),
  summary: v.optional(v.nullable(Counts)),
  idempotent: v.optional(v.boolean()),
});
const NumberRow = v.object({ n: v.number() });

function count(sql: string): number {
  return v.parse(NumberRow, database.query(sql).get()).n;
}

let database: Database;
let db: D1;
let preparedSql: string[];

beforeEach(async () => {
  preparedSql = [];
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
    INSERT INTO sims (
      iccid, sim_index, phone_number, country_code, carrier,
      service_type, service_type_source, service_type_verified_at
    ) VALUES (
      'notification-sim', 79, '+6590000079', 'SG', 'Singtel',
      'postpaid', 'contract_or_bill', '2026-01-01'
    );
  `);
  for (const name of [
    '066_add_carrier_billing.sql',
    '067_add_carrier_billing_account_events.sql',
  ]) {
    database.run(await Bun.file(new URL(`../../migrations/${name}`, import.meta.url)).text());
  }
  database
    .query(
      `
    INSERT INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES (
      'account-1', 'SG', 'Singtel', 'SGD', 'Singtel corporate',
      'notification-sim', ?, '5678', 'active', 'auth0|admin'
    )
  `,
    )
    .run(await sha256(ACCOUNT_REFERENCE));
  database.run(`
    INSERT INTO carrier_billing_account_sims (
      billing_account_id, sim_iccid, verification_source, verified_at, verified_by
    ) VALUES (
      'account-1', 'notification-sim', 'contract_or_bill',
      '2026-01-01', 'auth0|admin'
    );
  `);

  const insert = database.query(`
    INSERT INTO messages (
      id, phone_iccid, phone_number, content, timestamp, type
    ) VALUES (?, 'notification-sim', 'Singtel', ?, ?, 'received')
  `);
  for (let index = 0; index < MONTHS.length; index += 1) {
    const content = billMessage(index);
    const receivedYear = index === 0 ? 2025 : 2026;
    const receivedMonth = index === 0 ? 12 : index;
    const timestamp = `${String(receivedYear)}-${String(receivedMonth).padStart(2, '0')}-01T00:00:00Z`;
    if (index < 3) {
      const splitAt = content.indexOf('ill via My Singtel');
      const firstId = index === 2 ? 'message-3-part-1' : `message-${String(index + 1)}-part-1`;
      const secondId = index === 2 ? 'message-3-part-0' : `message-${String(index + 1)}-part-2`;
      const secondTimestamp = index === 2 ? timestamp : timestamp.replace('00Z', '30Z');
      insert.run(firstId, content.slice(0, splitAt), timestamp);
      insert.run(secondId, content.slice(splitAt, -1), secondTimestamp);
    } else {
      insert.run(`message-${String(index + 1)}`, content, timestamp);
    }
  }
  insert.run(
    'rebate',
    'We will provide a goodwill rebate on your next bill.',
    '2026-09-01T00:00:00Z',
  );
  const base = sqliteD1(database);
  db = {
    prepare: (sql) => {
      preparedSql.push(sql);
      return base.prepare(sql);
    },
  };
});

async function previewOf() {
  const response = await carrierBillingBackfillHandler.preview(
    bodyRequest(db, { account_id: 'account-1' }),
  );
  return v.parse(PreviewBody, await response.json());
}

describe('historical carrier bill backfill', () => {
  test('previews nine cycles including controlled fragment reassembly without writing', async () => {
    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.summary).toEqual({
      candidates: 9,
      complete_messages: 6,
      reassembled_messages: 3,
      new_bills: 9,
      duplicates: 0,
      conflicts: 0,
      already_processed: 0,
    });
    expect(preview.candidates).toHaveLength(9);
    expect(preview.candidates[0]?.source_message_ids).toHaveLength(2);
    expect(preview.candidates[8]).toMatchObject({
      amount_minor: 4808,
      due_date: '2026-09-14',
      disposition: 'new',
    });
    expect(preview.preview_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(count(`SELECT COUNT(*) AS n FROM carrier_bills`)).toBe(0);
    expect(preparedSql.some((sql) => sql.includes('content LIKE'))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes('instr(content, ?) = 1'))).toBe(true);
    expect(count(`SELECT COUNT(*) AS n FROM carrier_bill_events`)).toBe(0);
  });

  test('executes only an exact preview and is idempotent on retry', async () => {
    const previewResponse = await carrierBillingBackfillHandler.preview(
      bodyRequest(db, { account_id: 'account-1' }),
    );
    const preview = v.parse(PreviewBody, await previewResponse.json());
    const wrong = await carrierBillingBackfillHandler.execute(
      bodyRequest(
        db,
        {
          account_id: 'account-1',
          expected_version: preview.account.version,
          preview_digest: '0'.repeat(64),
        },
        { key: 'wrong-preview' },
      ),
    );
    const executeRequest = () =>
      bodyRequest(db, {
        account_id: 'account-1',
        expected_version: preview.account.version,
        preview_digest: preview.preview_digest,
      });
    const executed = await carrierBillingBackfillHandler.execute(executeRequest());
    const result = v.parse(ExecuteBody, await executed.json());
    const retry = await carrierBillingBackfillHandler.execute(executeRequest());

    expect(previewResponse.status).toBe(200);
    expect(wrong.status).toBe(409);
    expect(executed.status).toBe(200);
    expect(result.summary).toEqual({
      detected: 9,
      duplicate_detected: 0,
      parse_conflict: 0,
      already_processed: 0,
    });
    expect(count(`SELECT COUNT(*) AS n FROM carrier_bills`)).toBe(9);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM carrier_billing_account_events WHERE event_type = 'backfill_executed'`,
      ),
    ).toBe(1);
    expect(retry.status).toBe(200);
    expect(v.parse(ExecuteBody, await retry.json()).idempotent).toBe(true);
  });
});

describe('backfill preview route', () => {
  test('answers the public preview without the candidate messages', async () => {
    const response = await carrierBillingBackfillHandler.preview(
      bodyRequest(db, { account_id: 'account-1' }),
    );
    const body = v.parse(Record_, await response.json());
    const preview = v.parse(PreviewBody, body);

    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual([
      'success',
      'account',
      'summary',
      'preview_digest',
      'candidates',
    ]);
    expect(preview.candidates).toHaveLength(9);
    expect(preview.candidates[0]).not.toHaveProperty('message');
    expect(preview.candidates[0]).toHaveProperty('source_message_ids');
  });

  test('answers 400 for a body that is not JSON', async () => {
    const response = await carrierBillingBackfillHandler.preview(rawRequest(db, 'not json'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Body must be JSON' });
  });

  test('answers 400 when account_id is missing, empty or not a string', async () => {
    for (const body of [{}, { account_id: '' }, { account_id: 7 }, { account_id: null }, []]) {
      const response = await carrierBillingBackfillHandler.preview(bodyRequest(db, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'account_id is required' });
    }
  });

  test('answers 400 for a JSON body that is not an object', async () => {
    for (const body of [null, 'account-1', 7]) {
      const response = await carrierBillingBackfillHandler.preview(bodyRequest(db, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'account_id is required' });
    }
  });

  test('answers 409 for an account that is unknown or not active', async () => {
    database.run(`UPDATE carrier_billing_accounts SET status = 'inactive'`);
    for (const accountId of ['account-1', 'nope']) {
      const response = await carrierBillingBackfillHandler.preview(
        bodyRequest(db, { account_id: accountId }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Billing account must be active with a verified notification SIM',
      });
    }
  });

  test('lets a failure that is not an unready account propagate', async () => {
    const failing: D1 = {
      prepare() {
        throw new Error('D1 is down');
      },
    };

    let message = '';
    try {
      await carrierBillingBackfillHandler.preview(
        bodyRequest(failing, { account_id: 'account-1' }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toBe('D1 is down');
  });
});

describe('backfill execute route', () => {
  test('answers 401 without an actor, 400 without a bounded key, and 400 for a body that is not JSON', async () => {
    const preview = await previewOf();
    const body = {
      account_id: 'account-1',
      expected_version: preview.account.version,
      preview_digest: preview.preview_digest,
    };

    const anonymous = await carrierBillingBackfillHandler.execute(
      bodyRequest(db, body, { user: null }),
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'Unauthorized' });

    for (const key of [null, '   ', 'k'.repeat(201)]) {
      const response = await carrierBillingBackfillHandler.execute(bodyRequest(db, body, { key }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'A bounded Idempotency-Key header is required',
      });
    }

    const notJson = await carrierBillingBackfillHandler.execute(rawRequest(db, 'not json'));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'Body must be JSON' });
    expect(count(`SELECT COUNT(*) AS n FROM carrier_bills`)).toBe(0);
  });

  test('answers 409 with the current version when expected_version is stale', async () => {
    const preview = await previewOf();

    const response = await carrierBillingBackfillHandler.execute(
      bodyRequest(db, {
        account_id: 'account-1',
        expected_version: preview.account.version + 1,
        preview_digest: preview.preview_digest,
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Billing account version conflict',
      current_version: preview.account.version,
    });
  });

  test('answers 409 when the preview changed and 400 when it holds no bills', async () => {
    const preview = await previewOf();
    const body = {
      account_id: 'account-1',
      expected_version: preview.account.version,
      preview_digest: preview.preview_digest,
    };
    database.run(`UPDATE messages SET phone_number = 'Other'`);

    const changed = await carrierBillingBackfillHandler.execute(
      bodyRequest(db, body, { key: 'changed' }),
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'Backfill preview changed; run preview again' });

    const empty = await previewOf();
    expect(empty.candidates).toHaveLength(0);
    const none = await carrierBillingBackfillHandler.execute(
      bodyRequest(db, { ...body, preview_digest: empty.preview_digest }, { key: 'none' }),
    );
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: 'Backfill preview contains no bill candidates' });
    expect(count(`SELECT COUNT(*) AS n FROM carrier_bills`)).toBe(0);
  });

  test('answers 409 when the idempotency key was used for another account', async () => {
    database.run(`
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject, idempotency_key
      ) VALUES ('event-1', 'account-1', 'backfill_executed', 'auth0|admin', 'used');
    `);

    const response = await carrierBillingBackfillHandler.execute(
      bodyRequest(
        db,
        { account_id: 'account-2', expected_version: 1, preview_digest: 'x' },
        { key: 'used' },
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Idempotency key was already used for another account',
    });
  });

  test('replays the stored summary for a key already used, and null when it holds none', async () => {
    database.run(`
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject, idempotency_key, metadata_json
      ) VALUES
        ('event-1', 'account-1', 'backfill_executed', 'auth0|admin', 'with-summary',
         '{"summary":{"detected":2,"duplicate_detected":0,"parse_conflict":0,"already_processed":1}}'),
        ('event-2', 'account-1', 'backfill_executed', 'auth0|admin', 'without-summary', '{}'),
        ('event-4', 'account-1', 'backfill_executed', 'auth0|admin', 'odd-summary', '{"summary":5}');
    `);
    database.run(`PRAGMA ignore_check_constraints = ON`);
    database.run(`
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject, idempotency_key, metadata_json
      ) VALUES ('event-3', 'account-1', 'backfill_executed', 'auth0|admin', 'broken', 'not json');
    `);

    const replay = async (key: string) => {
      const response = await carrierBillingBackfillHandler.execute(
        bodyRequest(
          db,
          { account_id: 'account-1', expected_version: 1, preview_digest: 'x' },
          { key },
        ),
      );
      return response.json();
    };

    expect(await replay('with-summary')).toEqual({
      success: true,
      idempotent: true,
      summary: { detected: 2, duplicate_detected: 0, parse_conflict: 0, already_processed: 1 },
    });
    for (const key of ['without-summary', 'broken', 'odd-summary']) {
      expect(await replay(key)).toEqual({ success: true, idempotent: true, summary: null });
    }
  });

  test('counts a bill already stored as already_processed and records the execution', async () => {
    const preview = await previewOf();
    const body = {
      account_id: 'account-1',
      expected_version: preview.account.version,
      preview_digest: preview.preview_digest,
    };
    await carrierBillingBackfillHandler.execute(bodyRequest(db, body, { key: 'first' }));
    const refreshed = await previewOf();

    const again = await carrierBillingBackfillHandler.execute(
      bodyRequest(db, { ...body, preview_digest: refreshed.preview_digest }, { key: 'second' }),
    );
    const result = v.parse(ExecuteBody, await again.json());

    expect(result.summary).toEqual({
      detected: 0,
      duplicate_detected: 0,
      parse_conflict: 0,
      already_processed: 9,
    });
    expect(
      database
        .query(
          `SELECT actor_subject, idempotency_key FROM carrier_billing_account_events WHERE event_type = 'backfill_executed' ORDER BY rowid`,
        )
        .all(),
    ).toEqual([
      { actor_subject: 'auth0|admin', idempotency_key: 'first' },
      { actor_subject: 'auth0|admin', idempotency_key: 'second' },
    ]);
  });
});

describe('backfill request bodies', () => {
  test('execute answers 400 when a field has the wrong type', async () => {
    const preview = await previewOf();
    const valid = {
      account_id: 'account-1',
      expected_version: preview.account.version,
      preview_digest: preview.preview_digest,
    };

    for (const [body, error] of [
      [{ ...valid, account_id: 7 }, 'account_id is required'],
      [{ ...valid, account_id: '' }, 'account_id is required'],
      [{ ...valid, expected_version: String(valid.expected_version) }, MALFORMED_BODY],
      [{ ...valid, expected_version: 1.5 }, MALFORMED_BODY],
      [{ account_id: 'account-1', preview_digest: valid.preview_digest }, MALFORMED_BODY],
      [{ ...valid, preview_digest: 7 }, MALFORMED_BODY],
      [{ account_id: 'account-1', expected_version: valid.expected_version }, MALFORMED_BODY],
      [null, 'account_id is required'],
    ] as const) {
      const response = await carrierBillingBackfillHandler.execute(bodyRequest(db, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    expect(count(`SELECT COUNT(*) AS n FROM carrier_bills`)).toBe(0);
  });
});
