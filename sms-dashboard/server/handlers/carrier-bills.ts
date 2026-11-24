import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import { queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';
import {
  CarrierBillingLinkedSim,
  type CarrierBillingAccountsResponse,
} from '../../shared/api/carrier-billing.js';
import {
  BILL_URGENCIES,
  CarrierBill,
  CarrierBillEvent,
  CarrierBillSourceMessage,
  type CarrierBillConflict,
  type CarrierBillMutationResponse,
  type CarrierBillResponse,
  type CarrierBillsResponse,
  type CarrierBillMutationBody,
  type CarrierBillsQuery,
} from '../../shared/api/carrier-bills.js';

type BillUrgency = (typeof BILL_URGENCIES)[number];

type BillAction = 'payment_planned' | 'mark_paid' | 'waive' | 'reopen';

const BILL_COLUMNS = [
  'id',
  'billing_account_id',
  'source_message_id',
  'amount_minor',
  'currency',
  'due_date',
  'received_at',
  'parser_version',
  'action_status',
  'payment_planned_at',
  'paid_at',
  'paid_by',
  'operator_note',
  'version',
  'created_at',
  'updated_at',
]
  .map((column) => `b.${column}`)
  .join(', ');

/** A carrier_bills row joined with its account and notification SIM. */
const BillRow = v.object({
  ...v.omit(CarrierBill, ['account_ref_masked', 'notification_sim', 'urgency', 'days_remaining'])
    .entries,
  account_ref_last4: v.string(),
  notification_sim_index: v.nullable(v.number()),
  notification_sim_number: v.nullable(v.string()),
});

type BillRow = v.InferOutput<typeof BillRow>;

const BillEventRow = v.object({
  ...v.omit(CarrierBillEvent, ['metadata']).entries,
  metadata_json: v.string(),
});

const PriorEventRow = v.object({ bill_id: v.string() });

const AccountRow = v.object({
  id: v.string(),
  country_code: v.string(),
  carrier: v.string(),
  currency: v.string(),
  display_name: v.string(),
  account_ref_last4: v.string(),
  status: v.string(),
  version: v.number(),
  notification_sim_iccid: v.string(),
  notification_sim_index: v.nullable(v.number()),
  notification_sim_number: v.nullable(v.string()),
  payment_due_count: v.number(),
});

const AccountMemberRow = v.object({
  billing_account_id: v.string(),
  ...CarrierBillingLinkedSim.entries,
});

type BillDb = D1<'all' | 'first' | 'run'> & D1Batch<'all' | 'first' | 'run'>;

interface ReadCall {
  env: { DB: D1<'all' | 'first'> };
}

interface MutationCall {
  env: { DB: BillDb };
  user?: { id: string } | undefined;
}

/** A bill action as the contract hands it over: the bill, the retry key and the body. */
interface Mutation {
  id: string;
  idempotencyKey: string | undefined;
  body: v.InferOutput<typeof CarrierBillMutationBody>;
}

function versionConflict(bill: BillRow): ORPCError<'CONFLICT', CarrierBillConflict> {
  return new ORPCError('CONFLICT', {
    message: 'Bill version conflict',
    data: { current_version: bill.version, bill: presentBill(bill, singaporeDate()) },
  });
}

function singaporeDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function dateEpoch(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

export function deriveBillUrgency(
  bill: Pick<BillRow, 'due_date' | 'action_status'>,
  today: string = singaporeDate(),
): { urgency: BillUrgency; days_remaining: number } {
  const daysRemaining = Math.round((dateEpoch(bill.due_date) - dateEpoch(today)) / 86_400_000);
  let urgency: BillUrgency;
  if (bill.action_status === 'needs_review') urgency = 'needs_review';
  else if (bill.action_status === 'paid') urgency = 'paid';
  else if (bill.action_status === 'waived') urgency = 'waived';
  else if (daysRemaining < 0) urgency = 'overdue';
  else if (daysRemaining <= 7) urgency = 'due_soon';
  else urgency = 'open';
  return { urgency, days_remaining: daysRemaining };
}

function maskedAccount(last4: string): string {
  return `•••• ${last4}`;
}

function presentBill(row: BillRow, today: string) {
  const { account_ref_last4, notification_sim_index, notification_sim_number, ...rest } = row;
  return {
    ...rest,
    account_ref_masked: maskedAccount(account_ref_last4),
    notification_sim: {
      iccid: row.notification_sim_iccid,
      sim_index: notification_sim_index,
      number: notification_sim_number,
    },
    ...deriveBillUrgency(row, today),
  };
}

const BILL_SELECT = `
  SELECT
    ${BILL_COLUMNS},
    a.display_name AS account_display_name,
    a.carrier,
    a.account_ref_last4,
    a.notification_sim_iccid,
    d.sim_index AS notification_sim_index,
    d.number AS notification_sim_number,
    (
      SELECT COUNT(*)
      FROM carrier_billing_account_sims s
      WHERE s.billing_account_id = a.id AND s.removed_at IS NULL
    ) AS linked_sim_count
  FROM carrier_bills b
  INNER JOIN carrier_billing_accounts a ON a.id = b.billing_account_id
  LEFT JOIN device_view d ON d.iccid = a.notification_sim_iccid
`;

async function findBill(db: D1<'first'>, id: string): Promise<BillRow | null> {
  return queryFirst(db.prepare(`${BILL_SELECT} WHERE b.id = ?`).bind(id), BillRow);
}

function parseMetadata(text: string): unknown {
  const parsed = parseJson(text, v.unknown());
  return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {};
}

async function billDetail(db: D1<'all' | 'first'>, id: string, today: string) {
  const row = await findBill(db, id);
  if (!row) return null;

  const [members, events] = await Promise.all([
    queryAll(
      db
        .prepare(
          `
      SELECT
        s.sim_iccid AS iccid,
        d.sim_index,
        d.number,
        s.verification_source,
        s.verified_at,
        s.verified_by
      FROM carrier_billing_account_sims s
      LEFT JOIN device_view d ON d.iccid = s.sim_iccid
      WHERE s.billing_account_id = ? AND s.removed_at IS NULL
      ORDER BY d.sim_index, s.sim_iccid
    `,
        )
        .bind(row.billing_account_id),
      CarrierBillingLinkedSim,
    ),
    queryAll(
      db
        .prepare(
          `
      SELECT id, event_type, actor_type, actor_subject, source_message_id,
        metadata_json, created_at
      FROM carrier_bill_events
      WHERE bill_id = ?
      ORDER BY created_at, id
    `,
        )
        .bind(id),
      BillEventRow,
    ),
  ]);

  const sourceMessage = row.source_message_id
    ? await queryFirst(
        db
          .prepare(
            `
      SELECT id, phone_number AS sender, content, timestamp
      FROM messages WHERE id = ?
    `,
          )
          .bind(row.source_message_id),
        CarrierBillSourceMessage,
      )
    : null;

  return {
    ...presentBill(row, today),
    linked_sims: members,
    source_message: sourceMessage,
    events: events.map(({ metadata_json: metadataJson, ...event }) => ({
      ...event,
      metadata: parseMetadata(metadataJson),
    })),
  };
}

const URGENCY_ORDER = new Map<string, number>([
  ['needs_review', 0],
  ['overdue', 1],
  ['due_soon', 2],
  ['open', 3],
  ['paid', 4],
  ['waived', 5],
]);

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = dateEpoch(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** The detail of a bill a mutation just found or wrote; bills are never deleted. */
async function storedBillDetail(db: D1<'all' | 'first'>, id: string) {
  const bill = await billDetail(db, id, singaporeDate());
  if (bill === null) throw new Error(`Bill ${id} is missing after it was found`);
  return bill;
}

async function mutateBill(
  { env, user }: MutationCall,
  { id: billId, idempotencyKey: rawKey, body }: Mutation,
  action: BillAction,
): Promise<CarrierBillMutationResponse> {
  const db = env.DB;
  const actor = user?.id;
  const idempotencyKey = rawKey?.trim();
  if (!actor) throw new ORPCError('UNAUTHORIZED');
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'A bounded Idempotency-Key header is required',
    });
  }
  const expectedVersion = body.expected_version;
  const note = emptyToNull(body.note);

  const prior = await queryFirst(
    db
      .prepare(
        `
    SELECT bill_id FROM carrier_bill_events
    WHERE actor_subject = ? AND idempotency_key = ?
  `,
      )
      .bind(actor, idempotencyKey),
    PriorEventRow,
  );
  if (prior) {
    if (prior.bill_id !== billId) {
      throw new ORPCError('CONFLICT', {
        message: 'Idempotency key was already used for another bill',
      });
    }
    return { success: true, idempotent: true, bill: await storedBillDetail(db, billId) };
  }

  const current = await findBill(db, billId);
  if (!current) throw new ORPCError('NOT_FOUND', { message: 'Bill not found' });
  if (current.version !== expectedVersion) throw versionConflict(current);

  const next = (
    {
      payment_planned: {
        status: 'payment_planned',
        event: 'payment_planned',
        planned: true,
        paid: false,
      },
      mark_paid: { status: 'paid', event: 'paid', planned: false, paid: true },
      waive: { status: 'waived', event: 'waived', planned: false, paid: false },
      reopen: { status: 'unpaid', event: 'reopened', planned: false, paid: false },
    } satisfies Record<
      BillAction,
      { status: string; event: string; planned: boolean; paid: boolean }
    >
  )[action];

  const eventId = crypto.randomUUID();
  const metadata = JSON.stringify({
    from: current.action_status,
    to: next.status,
    note,
  });

  let updated: boolean;
  try {
    const results = await db.batch([
      db
        .prepare(
          `
        UPDATE carrier_bills
        SET action_status = ?,
            payment_planned_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            paid_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            paid_by = CASE WHEN ? = 1 THEN ? ELSE NULL END,
            operator_note = COALESCE(?, operator_note),
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND version = ?
      `,
        )
        .bind(
          next.status,
          next.planned ? 1 : 0,
          next.paid ? 1 : 0,
          next.paid ? 1 : 0,
          actor,
          note,
          billId,
          expectedVersion,
        ),
      db
        .prepare(
          `
        INSERT INTO carrier_bill_events (
          id, bill_id, event_type, actor_type, actor_subject,
          idempotency_key, metadata_json
        )
        SELECT ?, ?, ?, 'user', ?, ?, ?
        WHERE changes() = 1
      `,
        )
        .bind(eventId, billId, next.event, actor, idempotencyKey, metadata),
    ]);

    updated = results[0]?.meta.changes === 1;
  } catch (error) {
    const raced = await queryFirst(
      db
        .prepare(
          `
      SELECT bill_id FROM carrier_bill_events
      WHERE actor_subject = ? AND idempotency_key = ?
    `,
        )
        .bind(actor, idempotencyKey),
      PriorEventRow,
    );
    if (raced?.bill_id === billId) {
      return { success: true, idempotent: true, bill: await storedBillDetail(db, billId) };
    }
    throw error;
  }

  if (!updated) {
    const latest = await findBill(db, billId);
    if (!latest) throw new ORPCError('NOT_FOUND', { message: 'Bill not found' });
    throw versionConflict(latest);
  }
  return { success: true, bill: await storedBillDetail(db, billId) };
}

export const carrierBillsHandler = {
  async list(
    { env }: ReadCall,
    query: v.InferOutput<typeof CarrierBillsQuery>,
  ): Promise<CarrierBillsResponse> {
    const today = singaporeDate();
    const clauses: string[] = [];
    const params: string[] = [];
    const { carrier, account_id: accountId, from, to, status } = query;

    if (carrier) {
      clauses.push('a.carrier = ?');
      params.push(carrier);
    }
    if (accountId) {
      clauses.push('a.id = ?');
      params.push(accountId);
    }
    if (from) {
      if (!validIsoDate(from)) {
        throw new ORPCError('BAD_REQUEST', { message: 'from must be an ISO date' });
      }
      clauses.push('b.due_date >= ?');
      params.push(from);
    }
    if (to) {
      if (!validIsoDate(to)) {
        throw new ORPCError('BAD_REQUEST', { message: 'to must be an ISO date' });
      }
      clauses.push('b.due_date <= ?');
      params.push(to);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await queryAll(
      env.DB.prepare(
        `
      ${BILL_SELECT}
      ${where}
      ORDER BY b.due_date, b.id
      LIMIT 500
    `,
      ).bind(...params),
      BillRow,
    );
    let bills = rows.map((row) => presentBill(row, today));
    if (status)
      bills = bills.filter((bill) => bill.urgency === status || bill.action_status === status);
    bills.sort(
      (left, right) =>
        (URGENCY_ORDER.get(left.urgency) ?? 99) - (URGENCY_ORDER.get(right.urgency) ?? 99) ||
        left.due_date.localeCompare(right.due_date) ||
        left.id.localeCompare(right.id),
    );
    return { success: true, today, bills };
  },

  async listAccounts({ env }: ReadCall): Promise<CarrierBillingAccountsResponse> {
    const [accounts, members] = await Promise.all([
      queryAll(
        env.DB.prepare(
          `
        SELECT
          a.id, a.country_code, a.carrier, a.currency, a.display_name,
          a.account_ref_last4, a.status, a.version, a.notification_sim_iccid,
          d.sim_index AS notification_sim_index,
          d.number AS notification_sim_number,
          (
            SELECT COUNT(*)
            FROM carrier_bills b
            WHERE b.billing_account_id = a.id
              AND b.action_status IN ('unpaid', 'payment_planned')
          ) AS payment_due_count
        FROM carrier_billing_accounts a
        LEFT JOIN device_view d ON d.iccid = a.notification_sim_iccid
        ORDER BY a.carrier, a.display_name, a.id
      `,
        ),
        AccountRow,
      ),
      queryAll(
        env.DB.prepare(
          `
        SELECT
          s.billing_account_id,
          s.sim_iccid AS iccid,
          d.sim_index,
          d.number,
          s.verification_source,
          s.verified_at,
          s.verified_by
        FROM carrier_billing_account_sims s
        LEFT JOIN device_view d ON d.iccid = s.sim_iccid
        WHERE s.removed_at IS NULL
        ORDER BY s.billing_account_id, d.sim_index, s.sim_iccid
      `,
        ),
        AccountMemberRow,
      ),
    ]);
    return {
      success: true,
      accounts: accounts.map((account) => ({
        id: account.id,
        country_code: account.country_code,
        carrier: account.carrier,
        currency: account.currency,
        display_name: account.display_name,
        account_ref_masked: maskedAccount(account.account_ref_last4),
        status: account.status,
        version: account.version,
        payment_due_count: account.payment_due_count,
        notification_sim: {
          iccid: account.notification_sim_iccid,
          sim_index: account.notification_sim_index,
          number: account.notification_sim_number,
        },
        linked_sims: members
          .filter((member) => member.billing_account_id === account.id)
          .map(({ billing_account_id: _accountId, ...member }) => member),
      })),
    };
  },

  async get({ env }: ReadCall, id: string): Promise<CarrierBillResponse> {
    const bill = await billDetail(env.DB, id, singaporeDate());
    if (!bill) throw new ORPCError('NOT_FOUND', { message: 'Bill not found' });
    return { success: true, bill };
  },

  paymentPlanned: (call: MutationCall, mutation: Mutation) =>
    mutateBill(call, mutation, 'payment_planned'),
  markPaid: (call: MutationCall, mutation: Mutation) => mutateBill(call, mutation, 'mark_paid'),
  waive: (call: MutationCall, mutation: Mutation) => mutateBill(call, mutation, 'waive'),
  reopen: (call: MutationCall, mutation: Mutation) => mutateBill(call, mutation, 'reopen'),
};
