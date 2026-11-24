import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import type { D1, D1Statement } from '../lib/d1.js';
import { AccountNotReadyError, previewCarrierBillBackfill } from './carrier-billing-backfill.js';

const ACCOUNT_REFERENCE = '12345678';
const FRAGMENT_START = 'ill via My Singtel';

function billText({
  account = ACCOUNT_REFERENCE,
  amount = '42.80',
  dueDate = '14 Sep 2026',
}: { account?: string; amount?: string; dueDate?: string } = {}) {
  return `<Singtel>Dear customer, your latest bill for Singtel a/c ${account} is ready. The total amount is SGD$${amount} due on ${dueDate}. You can view and pay this bill via My Singtel app at www.singtel.com/viewbill .@`;
}

function fragments(text: string): [string, string] {
  const splitAt = text.indexOf(FRAGMENT_START);
  return [text.slice(0, splitAt), text.slice(splitAt, -1)];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let database: Database;
let db: D1;
let preparedSql: string[];

async function applyMigration(name: string) {
  database.run(await Bun.file(new URL(`../../migrations/${name}`, import.meta.url)).text());
}

beforeEach(async () => {
  preparedSql = [];
  database = new Database(':memory:');
  database.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (
      iccid TEXT PRIMARY KEY,
      sim_index INTEGER,
      service_type TEXT NOT NULL,
      country_code TEXT,
      carrier TEXT
    );
    CREATE VIEW device_view AS SELECT
      iccid, sim_index, service_type, country_code AS country, carrier
    FROM sims;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp TIMESTAMP,
      type TEXT
    );
    INSERT INTO sims VALUES
      ('notification-sim', 79, 'postpaid', 'SG', 'Singtel'),
      ('other-sim', 80, 'postpaid', 'SG', 'Singtel'),
      ('prepaid-sim', 81, 'prepaid', 'SG', 'Singtel');
  `);
  await applyMigration('066_add_carrier_billing.sql');
  await applyMigration('067_add_carrier_billing_account_events.sql');
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
      'account-1', 'notification-sim', 'contract_or_bill', '2026-01-01', 'auth0|admin'
    );
  `);
  const real = sqliteD1(database);
  db = {
    prepare: (sql) => {
      preparedSql.push(sql);
      return real.prepare(sql);
    },
  };
});

interface MessageFields {
  id: string;
  content: string;
  timestamp?: string | null;
  iccid?: string;
  sender?: string;
  type?: string;
}

function addMessage({
  id,
  content,
  timestamp = '2026-08-24T01:02:03Z',
  iccid = 'notification-sim',
  sender = 'Singtel',
  type = 'received',
}: MessageFields) {
  database
    .query(
      `INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, iccid, sender, content, timestamp, type);
}

function addBill(sourceMessageId: string | null, dueDate: string, amountMinor: number) {
  database
    .query(
      `INSERT INTO carrier_bills (id, billing_account_id, source_message_id, amount_minor,
         currency, due_date, received_at, parser_version)
       VALUES (?, 'account-1', ?, ?, 'SGD', ?, '2026-08-24T01:02:03Z', 'v1')`,
    )
    .run(`bill-${dueDate}`, sourceMessageId, amountMinor, dueDate);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('previewCarrierBillBackfill candidates', () => {
  test('lists a complete bill message with its parsed evidence', async () => {
    addMessage({ id: 'message-1', content: billText() });

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates).toEqual([
      {
        source_message_ids: ['message-1'],
        source_kind: 'complete',
        amount_minor: 4280,
        currency: 'SGD',
        due_date: '2026-09-14',
        received_at: '2026-08-24T01:02:03Z',
        parser_version: 'sg-singtel-postpaid-bill-sms-v1',
        message: {
          id: 'message-1',
          phone_iccid: 'notification-sim',
          phone_number: 'Singtel',
          content: billText(),
          timestamp: '2026-08-24T01:02:03Z',
          type: 'received',
        },
        disposition: 'new',
      },
    ]);
    expect(preview.summary).toEqual({
      candidates: 1,
      complete_messages: 1,
      reassembled_messages: 0,
      new_bills: 1,
      duplicates: 0,
      conflicts: 0,
      already_processed: 0,
    });
    expect(preview.account).toEqual({
      id: 'account-1',
      display_name: 'Singtel corporate',
      account_ref_masked: '•••• 5678',
      version: 1,
      notification_sim: { iccid: 'notification-sim', sim_index: 79 },
    });
    expect(preview.preview_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('scans with an anchored instr match, never a LIKE', async () => {
    await previewCarrierBillBackfill(db, 'account-1');

    expect(preparedSql.some((sql) => sql.includes('content LIKE'))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes('instr(content, ?) = 1'))).toBe(true);
  });

  test('reassembles a bill split across two messages', async () => {
    const [head, tail] = fragments(billText());
    addMessage({ id: 'part-1', content: head, timestamp: '2026-08-24T01:02:03Z' });
    addMessage({ id: 'part-2', content: tail, timestamp: '2026-08-24T01:02:30Z' });

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates).toMatchObject([
      {
        source_message_ids: ['part-1', 'part-2'],
        source_kind: 'reassembled',
        amount_minor: 4280,
        received_at: '2026-08-24T01:02:03Z',
        message: { id: 'part-1', content: `${head}${tail}`, timestamp: '2026-08-24T01:02:03Z' },
      },
    ]);
    expect(preview.summary).toMatchObject({ complete_messages: 0, reassembled_messages: 1 });
  });

  test('does not join a tail that arrives more than five minutes later or before the head', async () => {
    const [head, tail] = fragments(billText());
    addMessage({ id: 'part-1', content: head, timestamp: '2026-08-24T01:02:03Z' });
    addMessage({ id: 'late', content: tail, timestamp: '2026-08-24T01:07:04Z' });
    addMessage({ id: 'early', content: tail, timestamp: '2026-08-24T01:02:02Z' });

    expect((await previewCarrierBillBackfill(db, 'account-1')).candidates).toEqual([]);
  });

  test('joins a tail that arrives exactly five minutes later', async () => {
    const [head, tail] = fragments(billText());
    addMessage({ id: 'part-1', content: head, timestamp: '2026-08-24T01:02:03Z' });
    addMessage({ id: 'part-2', content: tail, timestamp: '2026-08-24T01:07:03Z' });

    expect((await previewCarrierBillBackfill(db, 'account-1')).candidates).toHaveLength(1);
  });

  test('joins the nearest tail, the lower id on a tie, and uses each tail once', async () => {
    const [head, tail] = fragments(billText());
    const [otherHead, otherTail] = fragments(billText({ dueDate: '14 Oct 2026' }));
    addMessage({ id: 'head-a', content: head, timestamp: '2026-08-24T01:00:00Z' });
    addMessage({ id: 'head-b', content: otherHead, timestamp: '2026-08-24T01:01:00Z' });
    addMessage({ id: 'tail-2', content: tail, timestamp: '2026-08-24T01:02:00Z' });
    addMessage({ id: 'tail-1', content: otherTail, timestamp: '2026-08-24T01:02:00Z' });

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates.map((candidate) => candidate.source_message_ids)).toEqual([
      ['head-a', 'tail-1'],
      ['head-b', 'tail-2'],
    ]);
  });

  test('ignores messages that are not received Singtel texts on the notification SIM', async () => {
    addMessage({ id: 'other-sim', content: billText(), iccid: 'other-sim' });
    addMessage({ id: 'sent', content: billText({ dueDate: '14 Oct 2026' }), type: 'sent' });
    addMessage({
      id: 'sender',
      content: billText({ dueDate: '14 Nov 2026' }),
      sender: 'Singtel Biz',
    });
    addMessage({ id: 'prose', content: 'We will provide a goodwill rebate on your next bill.' });

    expect((await previewCarrierBillBackfill(db, 'account-1')).candidates).toEqual([]);
  });

  test('ignores a bill for a different account reference', async () => {
    addMessage({ id: 'other-account', content: billText({ account: '87654321' }) });

    expect((await previewCarrierBillBackfill(db, 'account-1')).candidates).toEqual([]);
  });

  test('keeps a bill message without a timestamp, as received at null', async () => {
    addMessage({ id: 'no-time', content: billText(), timestamp: null });

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates).toMatchObject([
      { source_message_ids: ['no-time'], received_at: null, message: { timestamp: null } },
    ]);
  });

  test('orders candidates by due date', async () => {
    addMessage({
      id: 'oct',
      content: billText({ dueDate: '14 Oct 2026' }),
      timestamp: '2026-08-01T00:00:00Z',
    });
    addMessage({
      id: 'sep',
      content: billText({ dueDate: '14 Sep 2026' }),
      timestamp: '2026-09-01T00:00:00Z',
    });

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates.map((candidate) => candidate.due_date)).toEqual([
      '2026-09-14',
      '2026-10-14',
    ]);
  });
});

describe('previewCarrierBillBackfill dispositions', () => {
  test('marks a message that already produced a bill as processed', async () => {
    addMessage({ id: 'message-1', content: billText() });
    addBill('message-1', '2026-09-14', 4280);

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates.map((candidate) => candidate.disposition)).toEqual([
      'already_processed',
    ]);
    expect(preview.summary).toMatchObject({ already_processed: 1, new_bills: 0 });
  });

  test('marks a message that only has an event as processed', async () => {
    addMessage({ id: 'message-1', content: billText() });
    addBill(null, '2026-09-14', 4280);
    database
      .query(
        `INSERT INTO carrier_bill_events (id, bill_id, event_type, actor_type, source_message_id)
         VALUES ('event-1', 'bill-2026-09-14', 'duplicate_detected', 'system', 'message-1')`,
      )
      .run();

    expect(
      (await previewCarrierBillBackfill(db, 'account-1')).candidates.map(
        (candidate) => candidate.disposition,
      ),
    ).toEqual(['already_processed']);
  });

  test('treats a reassembled bill as processed when either part was', async () => {
    const [head, tail] = fragments(billText());
    addMessage({ id: 'part-1', content: head, timestamp: '2026-08-24T01:02:03Z' });
    addMessage({ id: 'part-2', content: tail, timestamp: '2026-08-24T01:02:30Z' });
    addBill('part-2', '2026-09-14', 4280);

    expect(
      (await previewCarrierBillBackfill(db, 'account-1')).candidates.map(
        (candidate) => candidate.disposition,
      ),
    ).toEqual(['already_processed']);
  });

  test('marks a cycle that already has the same amount a duplicate', async () => {
    addMessage({ id: 'message-1', content: billText() });
    addBill(null, '2026-09-14', 4280);

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates.map((candidate) => candidate.disposition)).toEqual(['duplicate']);
    expect(preview.summary).toMatchObject({ duplicates: 1, new_bills: 0 });
  });

  test('marks a cycle that already has another amount a conflict', async () => {
    addMessage({ id: 'message-1', content: billText() });
    addBill(null, '2026-09-14', 9999);

    const preview = await previewCarrierBillBackfill(db, 'account-1');

    expect(preview.candidates.map((candidate) => candidate.disposition)).toEqual(['conflict']);
    expect(preview.summary).toMatchObject({ conflicts: 1, new_bills: 0 });
  });
});

describe('previewCarrierBillBackfill digest', () => {
  test('is stable for the same evidence and changes with it or with the account version', async () => {
    addMessage({ id: 'message-1', content: billText() });
    const first = await previewCarrierBillBackfill(db, 'account-1');
    const again = await previewCarrierBillBackfill(db, 'account-1');
    expect(again.preview_digest).toBe(first.preview_digest);

    addMessage({ id: 'message-2', content: billText({ dueDate: '14 Oct 2026' }) });
    const more = await previewCarrierBillBackfill(db, 'account-1');
    expect(more.preview_digest).not.toBe(first.preview_digest);

    database.query(`UPDATE carrier_billing_accounts SET version = 2`).run();
    const bumped = await previewCarrierBillBackfill(db, 'account-1');
    expect(bumped.account.version).toBe(2);
    expect(bumped.preview_digest).not.toBe(more.preview_digest);
  });

  test('does not depend on whether the bill is already processed', async () => {
    addMessage({ id: 'message-1', content: billText() });
    const before = await previewCarrierBillBackfill(db, 'account-1');
    addBill('message-1', '2026-09-14', 4280);

    expect((await previewCarrierBillBackfill(db, 'account-1')).preview_digest).toBe(
      before.preview_digest,
    );
  });
});

describe('previewCarrierBillBackfill account readiness', () => {
  const message = 'Billing account must be active with a verified notification SIM';

  async function notReady(accountId: string) {
    const error = await failure(previewCarrierBillBackfill(db, accountId));
    expect(error).toBeInstanceOf(AccountNotReadyError);
    if (!(error instanceof AccountNotReadyError)) throw error;
    expect(error.message).toBe(message);
    expect(error.code).toBe('ACCOUNT_NOT_READY');
  }

  test('rejects an unknown account', async () => {
    await notReady('no-such-account');
  });

  test('rejects an account that is not active', async () => {
    database.query(`UPDATE carrier_billing_accounts SET status = 'inactive'`).run();
    await notReady('account-1');
  });

  test('rejects an account whose notification SIM is no longer postpaid', async () => {
    database.query(`UPDATE sims SET service_type = 'prepaid'`).run();
    await notReady('account-1');
  });

  test('rejects an account whose notification SIM was removed from it', async () => {
    database.query(`UPDATE carrier_billing_account_sims SET removed_at = '2026-02-01'`).run();
    await notReady('account-1');
  });
});

describe('previewCarrierBillBackfill row schemas', () => {
  test('fails when the account row does not match its schema', async () => {
    const statement: D1Statement<'first' | 'all'> = {
      bind: () => statement,
      first: () => Promise.resolve({ id: 1 }),
      all: () => Promise.resolve({ results: [] }),
    };

    expect(
      await failure(previewCarrierBillBackfill({ prepare: () => statement }, 'a')),
    ).toBeInstanceOf(Error);
  });

  test('fails when a message row does not match its schema', async () => {
    const rows: unknown[] = [
      {
        id: 'account-1',
        display_name: 'Singtel corporate',
        account_ref_digest: 'a'.repeat(64),
        account_ref_last4: '5678',
        notification_sim_iccid: 'notification-sim',
        status: 'active',
        version: 1,
        notification_sim_index: 79,
      },
    ];
    const statement: D1Statement<'first' | 'all'> = {
      bind: () => statement,
      first: () => Promise.resolve(rows.shift()),
      all: () => Promise.resolve({ results: [{ id: 5 }] }),
    };

    expect(
      await failure(previewCarrierBillBackfill({ prepare: () => statement }, 'a')),
    ).toBeInstanceOf(Error);
  });
});
