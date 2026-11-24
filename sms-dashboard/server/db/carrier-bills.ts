import * as v from 'valibot';
import {
  CarrierBill,
  CarrierBillEvent,
  CarrierBillSourceMessage,
} from '../../shared/api/carrier-bills.js';
import { queryAll, queryFirst, type D1, type D1Batch, type D1RunResult } from '../lib/d1.js';

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

export const BillRow = v.object({
  ...v.omit(CarrierBill, ['account_ref_masked', 'notification_sim', 'urgency', 'days_remaining'])
    .entries,
  account_ref_last4: v.string(),
  notification_sim_index: v.nullable(v.number()),
  notification_sim_number: v.nullable(v.string()),
});

export type BillRow = v.InferOutput<typeof BillRow>;

const BillEventRow = v.object({
  ...v.omit(CarrierBillEvent, ['metadata']).entries,
  metadata_json: v.string(),
});

const PriorEventRow = v.object({ bill_id: v.string() });

const ExistingBillRow = v.object({
  id: v.string(),
  amount_minor: v.number(),
  currency: v.string(),
});

const CycleRow = v.object({ amount_minor: v.number(), currency: v.string() });

interface BillFilters {
  carrier: string | undefined;
  accountId: string | undefined;
  from: string | undefined;
  to: string | undefined;
}

interface BillAction {
  billId: string;
  expectedVersion: number;
  actor: string;
  idempotencyKey: string;
  note: string | null;
  status: string;
  planned: boolean;
  paid: boolean;
  eventId: string;
  eventType: string;
  metadata: string;
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

export function findBill(db: D1<'first'>, id: string): Promise<BillRow | null> {
  return queryFirst(db.prepare(`${BILL_SELECT} WHERE b.id = ?`).bind(id), BillRow);
}

export function listBills(
  db: D1<'all'>,
  { carrier, accountId, from, to }: BillFilters,
): Promise<BillRow[]> {
  const clauses: string[] = [];
  const params: string[] = [];

  if (carrier) {
    clauses.push('a.carrier = ?');
    params.push(carrier);
  }
  if (accountId) {
    clauses.push('a.id = ?');
    params.push(accountId);
  }
  if (from) {
    clauses.push('b.due_date >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('b.due_date <= ?');
    params.push(to);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return queryAll(
    db
      .prepare(
        `
      ${BILL_SELECT}
      ${where}
      ORDER BY b.due_date, b.id
      LIMIT 500
    `,
      )
      .bind(...params),
    BillRow,
  );
}

export function listBillEvents(db: D1<'all'>, billId: string) {
  return queryAll(
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
      .bind(billId),
    BillEventRow,
  );
}

export function findBillSourceMessage(db: D1<'first'>, messageId: string) {
  return queryFirst(
    db
      .prepare(
        `
      SELECT id, phone_number AS sender, content, timestamp
      FROM messages WHERE id = ?
    `,
      )
      .bind(messageId),
    CarrierBillSourceMessage,
  );
}

export function findBillIdByIdempotencyKey(
  db: D1<'first'>,
  actor: string,
  idempotencyKey: string,
): Promise<{ bill_id: string } | null> {
  return queryFirst(
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
}

export async function applyBillAction(
  db: D1<'run'> & D1Batch<'run'>,
  action: BillAction,
): Promise<boolean> {
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
        action.status,
        action.planned ? 1 : 0,
        action.paid ? 1 : 0,
        action.paid ? 1 : 0,
        action.actor,
        action.note,
        action.billId,
        action.expectedVersion,
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
      .bind(
        action.eventId,
        action.billId,
        action.eventType,
        action.actor,
        action.idempotencyKey,
        action.metadata,
      ),
  ]);
  return results[0]?.meta.changes === 1;
}

export function findProcessedBill(
  db: D1<'first'>,
  sourceMessageId: string,
): Promise<{ bill_id: string } | null> {
  return queryFirst(
    db
      .prepare(
        `
    SELECT id AS bill_id
    FROM carrier_bills
    WHERE source_message_id = ?
    UNION ALL
    SELECT bill_id
    FROM carrier_bill_events
    WHERE source_message_id = ?
    LIMIT 1
  `,
      )
      .bind(sourceMessageId, sourceMessageId),
    PriorEventRow,
  );
}

export function findProcessedBillAmong(
  db: D1<'first'>,
  sourceMessageIds: readonly string[],
): Promise<{ bill_id: string } | null> {
  const placeholders = sourceMessageIds.map(() => '?').join(', ');
  return queryFirst(
    db
      .prepare(
        `
    SELECT id AS bill_id
    FROM carrier_bills
    WHERE source_message_id IN (${placeholders})
    UNION ALL
    SELECT bill_id
    FROM carrier_bill_events
    WHERE source_message_id IN (${placeholders})
    LIMIT 1
  `,
      )
      .bind(...sourceMessageIds, ...sourceMessageIds),
    PriorEventRow,
  );
}

export function insertBillIfAbsent(
  db: D1<'run'>,
  bill: {
    id: string;
    billingAccountId: string;
    sourceMessageId: string;
    amountMinor: number;
    currency: string;
    dueDate: string;
    receivedAt: string;
    parserVersion: string;
  },
): Promise<D1RunResult> {
  return db
    .prepare(
      `
    INSERT OR IGNORE INTO carrier_bills (
      id, billing_account_id, source_message_id, amount_minor, currency,
      due_date, received_at, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(
      bill.id,
      bill.billingAccountId,
      bill.sourceMessageId,
      bill.amountMinor,
      bill.currency,
      bill.dueDate,
      bill.receivedAt,
      bill.parserVersion,
    )
    .run();
}

export function findBillForCycle(db: D1<'first'>, accountId: string, dueDate: string) {
  return queryFirst(
    db
      .prepare(
        `
    SELECT id, amount_minor, currency
    FROM carrier_bills
    WHERE billing_account_id = ? AND due_date = ?
  `,
      )
      .bind(accountId, dueDate),
    ExistingBillRow,
  );
}

export function findBillAmountForCycle(db: D1<'first'>, accountId: string, dueDate: string) {
  return queryFirst(
    db
      .prepare(
        `
    SELECT amount_minor, currency
    FROM carrier_bills
    WHERE billing_account_id = ? AND due_date = ?
  `,
      )
      .bind(accountId, dueDate),
    CycleRow,
  );
}

export function insertSystemBillEvent(
  db: D1<'run'>,
  {
    billId,
    eventType,
    sourceMessageId,
    metadata,
  }: {
    billId: string;
    eventType: string;
    sourceMessageId: string;
    metadata: object;
  },
): Promise<D1RunResult> {
  return db
    .prepare(
      `
    INSERT OR IGNORE INTO carrier_bill_events (
      id, bill_id, event_type, actor_type, source_message_id, metadata_json
    ) VALUES (?, ?, ?, 'system', ?, ?)
  `,
    )
    .bind(crypto.randomUUID(), billId, eventType, sourceMessageId, JSON.stringify(metadata))
    .run();
}

export function markBillNeedsReview(db: D1<'run'>, billId: string): Promise<D1RunResult> {
  return db
    .prepare(
      `
      UPDATE carrier_bills
      SET action_status = 'needs_review',
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .bind(billId)
    .run();
}
