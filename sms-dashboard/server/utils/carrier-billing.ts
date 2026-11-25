import * as v from 'valibot';
import { formatCardNumber } from '../../shared/card-number.js';
import type { D1 } from '../lib/d1.js';
import {
  findBillForCycle,
  findProcessedBill,
  insertBillIfAbsent,
  insertSystemBillEvent,
  markBillNeedsReview,
} from '../db/carrier-bills.js';
import {
  findActiveStream,
  findEligibleReceivingSim,
  insertSingtelAccountIfAbsent,
  linkSimToAccount,
  listUnprocessedBillMessages,
  type BillingStream,
  type ReceivingSim,
} from '../db/carrier-billing.js';
import { parseSingtelPostpaidBillSms } from './singtel-postpaid-bill.js';
import type { SingtelBill } from './singtel-postpaid-bill.js';

const RECONCILIATION_PAGE_SIZE = 100;
const SINGTEL_BILL_PREFIX = '<Singtel>Dear customer, your latest bill for Singtel a/c ';

export type BillOutcome =
  'detected' | 'duplicate_detected' | 'parse_conflict' | 'already_processed' | 'ignored' | 'failed';

export interface BillProcessingResult {
  outcome: BillOutcome;
  bill_id?: string;
}

const BillCandidate = v.object({
  id: v.string(),
  phone_iccid: v.string(),
  phone_number: v.literal('Singtel'),
  content: v.string(),
  timestamp: v.string(),
  type: v.literal('received'),
});

type BillCandidateMessage = v.InferOutput<typeof BillCandidate>;

async function ensureBillingStream(
  db: D1,
  sim: ReceivingSim,
  parsed: SingtelBill,
): Promise<BillingStream | null> {
  const existing = await findActiveStream(db, sim.iccid);
  if (existing) {
    if (existing.account_ref_digest !== parsed.account_ref_digest) return null;
    await linkSimToAccount(db, existing.id, sim.iccid);
    return existing;
  }

  const accountId = crypto.randomUUID();
  await insertSingtelAccountIfAbsent(db, {
    id: accountId,
    displayName: `${formatCardNumber(sim.sim_index)} Singtel postpaid`,
    notificationSimIccid: sim.iccid,
    accountRefDigest: parsed.account_ref_digest,
    accountRefLast4: parsed.account_ref_last4,
  });

  const created = await findActiveStream(db, sim.iccid);
  if (created?.account_ref_digest !== parsed.account_ref_digest) return null;
  await linkSimToAccount(db, created.id, sim.iccid);
  return created;
}

async function storeParsedBill(
  db: D1,
  account: BillingStream,
  message: BillCandidateMessage,
  parsed: SingtelBill,
): Promise<BillProcessingResult> {
  const prior = await findProcessedBill(db, message.id);
  if (prior) {
    return { outcome: 'already_processed', bill_id: prior.bill_id };
  }

  const billId = crypto.randomUUID();
  const insert = await insertBillIfAbsent(db, {
    id: billId,
    billingAccountId: account.id,
    sourceMessageId: message.id,
    amountMinor: parsed.amount_minor,
    currency: parsed.currency,
    dueDate: parsed.due_date,
    receivedAt: message.timestamp,
    parserVersion: parsed.parser_version,
  });

  if (insert.meta.changes === 1) {
    await insertSystemBillEvent(db, {
      billId,
      eventType: 'detected',
      sourceMessageId: message.id,
      metadata: { source: 'sms' },
    });
    return { outcome: 'detected', bill_id: billId };
  }

  const existing = await findBillForCycle(db, account.id, parsed.due_date);
  if (!existing) {
    const raced = await findProcessedBill(db, message.id);
    if (raced) return { outcome: 'already_processed', bill_id: raced.bill_id };
    throw new Error('Carrier bill insert was ignored without an existing bill');
  }

  const duplicate =
    existing.amount_minor === parsed.amount_minor && existing.currency === parsed.currency;
  const eventType = duplicate ? 'duplicate_detected' : 'parse_conflict';
  const event = await insertSystemBillEvent(db, {
    billId: existing.id,
    eventType,
    sourceMessageId: message.id,
    metadata: duplicate
      ? { source: 'sms' }
      : {
          source: 'sms',
          observed_amount_minor: parsed.amount_minor,
          observed_currency: parsed.currency,
          retained_amount_minor: existing.amount_minor,
          retained_currency: existing.currency,
        },
  });

  if (!duplicate && event.meta.changes === 1) {
    await markBillNeedsReview(db, existing.id);
  }

  return {
    outcome: duplicate ? 'duplicate_detected' : 'parse_conflict',
    bill_id: existing.id,
  };
}

export async function processCarrierBillMessage(
  db: D1,
  message: unknown,
): Promise<BillProcessingResult> {
  const candidate = v.safeParse(BillCandidate, message);
  if (!candidate.success) return { outcome: 'ignored' };

  const parsed = await parseSingtelPostpaidBillSms({
    sender: candidate.output.phone_number,
    content: candidate.output.content,
  });
  if (!parsed) return { outcome: 'ignored' };

  const sim = await findEligibleReceivingSim(db, candidate.output.phone_iccid);
  if (!sim) return { outcome: 'ignored' };

  const stream = await ensureBillingStream(db, sim, parsed);
  if (stream?.currency !== parsed.currency) return { outcome: 'ignored' };
  return storeParsedBill(db, stream, candidate.output, parsed);
}

function describeMessage(message: unknown): string {
  if (typeof message !== 'object' || message === null || !('id' in message)) return 'unknown';
  const { id } = message;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : 'unknown';
}

export async function processCarrierBillMessages(
  db: D1,
  messages: readonly unknown[],
  {
    processMessage = processCarrierBillMessage,
    logError = console.error,
  }: {
    processMessage?: typeof processCarrierBillMessage;
    logError?: (...args: unknown[]) => void;
  } = {},
): Promise<BillProcessingResult[]> {
  return Promise.all(
    messages.map(async (message): Promise<BillProcessingResult> => {
      try {
        return await processMessage(db, message);
      } catch (error) {
        logError(`Carrier bill processing failed for message ${describeMessage(message)}:`, error);
        return { outcome: 'failed' };
      }
    }),
  );
}

export async function reconcileCarrierBillMessages(
  db: D1,
  { pageSize = RECONCILIATION_PAGE_SIZE }: { pageSize?: number } = {},
): Promise<{ scanned: number; detected: number; remaining: number }> {
  const limit = Math.max(1, Math.min(pageSize || RECONCILIATION_PAGE_SIZE, 500));
  const candidates = await listUnprocessedBillMessages(db, SINGTEL_BILL_PREFIX, limit + 1);
  const page = candidates.slice(0, limit);
  let detected = 0;

  for (const message of page) {
    const result = await processCarrierBillMessage(db, message);
    if (result.outcome === 'detected') detected += 1;
  }

  return {
    scanned: page.length,
    detected,
    remaining: candidates.length > limit ? 1 : 0,
  };
}
