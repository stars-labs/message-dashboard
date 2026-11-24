import type { D1 } from '../lib/d1.js';
import { findBillAmountForCycle, findProcessedBillAmong } from '../db/carrier-bills.js';
import {
  findBillableAccount,
  listBackfillMessages,
  type ScanMessage,
} from '../db/carrier-billing.js';
import { parseSingtelPostpaidBillSms } from './singtel-postpaid-bill.js';
import type {
  BackfillAccount,
  BackfillCandidate as PublicBackfillCandidate,
  BackfillSummary,
} from '../../shared/api/carrier-billing.js';

const BILL_PREFIX = '<Singtel>Dear customer, your latest bill for Singtel a/c ';
const BILL_FRAGMENT_SUFFIX = 'ill via My Singtel app at www.singtel.com/viewbill .';
const MAX_FRAGMENT_GAP_MS = 5 * 60 * 1000;

/** One bill candidate in a preview, with the message it would store. */
export type BackfillCandidate = PublicBackfillCandidate & {
  message: {
    id: string;
    phone_iccid: string;
    phone_number: 'Singtel';
    content: string;
    timestamp: string | null;
    type: 'received';
  };
};

export interface BackfillPreview {
  account: BackfillAccount;
  summary: BackfillSummary;
  candidates: BackfillCandidate[];
  preview_digest: string;
}

function timeOf(timestamp: string | null): number {
  return timestamp === null ? Number.NaN : Date.parse(timestamp);
}

/** Thrown when the account is not active or its notification SIM is unverified. */
export class AccountNotReadyError extends Error {
  readonly code = 'ACCOUNT_NOT_READY';

  constructor(message: string) {
    super(message);
    this.name = 'AccountNotReadyError';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function dispositionFor(
  db: D1<'first'>,
  accountId: string,
  candidate: Pick<
    BackfillCandidate,
    'source_message_ids' | 'due_date' | 'amount_minor' | 'currency'
  >,
): Promise<BackfillCandidate['disposition']> {
  const processed = await findProcessedBillAmong(db, candidate.source_message_ids);
  if (processed) return 'already_processed';

  const cycle = await findBillAmountForCycle(db, accountId, candidate.due_date);
  if (!cycle) return 'new';
  return cycle.amount_minor === candidate.amount_minor && cycle.currency === candidate.currency
    ? 'duplicate'
    : 'conflict';
}

export async function previewCarrierBillBackfill(
  db: D1<'first' | 'all'>,
  accountId: string,
): Promise<BackfillPreview> {
  const account = await findBillableAccount(db, accountId);
  if (!account) {
    throw new AccountNotReadyError(
      'Billing account must be active with a verified notification SIM',
    );
  }

  const messages = await listBackfillMessages(
    db,
    account.notification_sim_iccid,
    BILL_PREFIX,
    BILL_FRAGMENT_SUFFIX,
  );
  const used = new Set<string>();
  const candidates: Omit<BackfillCandidate, 'disposition'>[] = [];

  for (const first of messages) {
    if (used.has(first.id) || !first.content.startsWith(BILL_PREFIX)) continue;

    let content = first.content;
    let sourceMessages: ScanMessage[] = [first];
    let parsed = await parseSingtelPostpaidBillSms({
      sender: 'Singtel',
      content,
      expectedAccountRefDigest: account.account_ref_digest,
    });
    let reassembled = false;

    if (!parsed && content.endsWith('b')) {
      const firstTime = timeOf(first.timestamp);
      let second: ScanMessage | null = null;
      let secondGap = Number.POSITIVE_INFINITY;
      for (const message of messages) {
        if (used.has(message.id) || message.content.trim() !== BILL_FRAGMENT_SUFFIX) continue;
        const gap = timeOf(message.timestamp) - firstTime;
        if (!Number.isFinite(gap) || gap < 0 || gap > MAX_FRAGMENT_GAP_MS) continue;
        if (gap < secondGap || (gap === secondGap && second !== null && message.id < second.id)) {
          second = message;
          secondGap = gap;
        }
      }
      if (second) {
        content = `${content}${second.content.trim()}`;
        parsed = await parseSingtelPostpaidBillSms({
          sender: 'Singtel',
          content,
          expectedAccountRefDigest: account.account_ref_digest,
        });
        if (parsed) {
          sourceMessages = [first, second];
          used.add(second.id);
          reassembled = true;
        }
      }
    }
    if (!parsed) continue;
    used.add(first.id);
    candidates.push({
      source_message_ids: sourceMessages.map((message) => message.id),
      source_kind: reassembled ? 'reassembled' : 'complete',
      amount_minor: parsed.amount_minor,
      currency: parsed.currency,
      due_date: parsed.due_date,
      received_at: first.timestamp,
      parser_version: parsed.parser_version,
      message: {
        id: first.id,
        phone_iccid: first.phone_iccid,
        phone_number: 'Singtel',
        content,
        timestamp: first.timestamp,
        type: 'received',
      },
    });
  }

  candidates.sort((left, right) => left.due_date.localeCompare(right.due_date));
  const resolved: BackfillCandidate[] = [];
  for (const candidate of candidates) {
    resolved.push({ ...candidate, disposition: await dispositionFor(db, accountId, candidate) });
  }

  const digestEvidence = resolved.map((candidate) => ({
    source_message_ids: candidate.source_message_ids,
    source_kind: candidate.source_kind,
    amount_minor: candidate.amount_minor,
    currency: candidate.currency,
    due_date: candidate.due_date,
    received_at: candidate.received_at,
    parser_version: candidate.parser_version,
  }));
  const summary: BackfillSummary = {
    candidates: resolved.length,
    complete_messages: resolved.filter((candidate) => candidate.source_kind === 'complete').length,
    reassembled_messages: resolved.filter((candidate) => candidate.source_kind === 'reassembled')
      .length,
    new_bills: resolved.filter((candidate) => candidate.disposition === 'new').length,
    duplicates: resolved.filter((candidate) => candidate.disposition === 'duplicate').length,
    conflicts: resolved.filter((candidate) => candidate.disposition === 'conflict').length,
    already_processed: resolved.filter((candidate) => candidate.disposition === 'already_processed')
      .length,
  };

  return {
    account: {
      id: account.id,
      display_name: account.display_name,
      account_ref_masked: `•••• ${account.account_ref_last4}`,
      version: account.version,
      notification_sim: {
        iccid: account.notification_sim_iccid,
        sim_index: account.notification_sim_index,
      },
    },
    summary,
    candidates: resolved,
    preview_digest: await sha256(
      JSON.stringify({
        account_id: accountId,
        account_version: account.version,
        candidates: digestEvidence,
      }),
    ),
  };
}
