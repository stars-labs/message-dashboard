import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import type { D1, D1Batch } from '../lib/d1.js';
import {
  applyBillAction,
  findBill,
  findBillIdByIdempotencyKey,
  findBillSourceMessage,
  listBillEvents,
  listBills,
  type BillRow,
} from '../db/carrier-bills.js';
import {
  listBillingAccountMembers,
  listBillingAccounts,
  listLinkedSims,
} from '../db/carrier-billing.js';
import type { CarrierBillingAccountsResponse } from '../../shared/api/carrier-billing.js';
import {
  BILL_URGENCIES,
  type CarrierBillConflict,
  type CarrierBillMutationResponse,
  type CarrierBillResponse,
  type CarrierBillsResponse,
  type CarrierBillMutationBody,
  type CarrierBillsQuery,
} from '../../shared/api/carrier-bills.js';

type BillUrgency = (typeof BILL_URGENCIES)[number];

type BillAction = 'payment_planned' | 'mark_paid' | 'waive' | 'reopen';

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

function parseMetadata(text: string): unknown {
  const parsed = parseJson(text, v.unknown());
  return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {};
}

async function billDetail(db: D1<'all' | 'first'>, id: string, today: string) {
  const row = await findBill(db, id);
  if (!row) return null;

  const [members, events] = await Promise.all([
    listLinkedSims(db, row.billing_account_id),
    listBillEvents(db, id),
  ]);

  const sourceMessage = row.source_message_id
    ? await findBillSourceMessage(db, row.source_message_id)
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

  const prior = await findBillIdByIdempotencyKey(db, actor, idempotencyKey);
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
    updated = await applyBillAction(db, {
      billId,
      expectedVersion,
      actor,
      idempotencyKey,
      note,
      status: next.status,
      planned: next.planned,
      paid: next.paid,
      eventId,
      eventType: next.event,
      metadata,
    });
  } catch (error) {
    const raced = await findBillIdByIdempotencyKey(db, actor, idempotencyKey);
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
    const { carrier, account_id: accountId, from, to, status } = query;

    if (from && !validIsoDate(from)) {
      throw new ORPCError('BAD_REQUEST', { message: 'from must be an ISO date' });
    }
    if (to && !validIsoDate(to)) {
      throw new ORPCError('BAD_REQUEST', { message: 'to must be an ISO date' });
    }

    const rows = await listBills(env.DB, { carrier, accountId, from, to });
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
      listBillingAccounts(env.DB),
      listBillingAccountMembers(env.DB),
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
