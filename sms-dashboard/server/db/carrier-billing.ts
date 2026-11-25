import * as v from 'valibot';
import { CarrierBillingLinkedSim } from '../../shared/api/carrier-billing.js';
import { queryAll, queryFirst, type D1, type D1RunResult } from '../lib/d1.js';

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

const ReceivingSimRow = v.object({ iccid: v.string(), sim_index: v.number() });

export type ReceivingSim = v.InferOutput<typeof ReceivingSimRow>;

const BillingStreamRow = v.object({
  id: v.string(),
  currency: v.string(),
  account_ref_digest: v.string(),
});

export type BillingStream = v.InferOutput<typeof BillingStreamRow>;

const BillableAccountRow = v.object({
  id: v.string(),
  display_name: v.string(),
  account_ref_digest: v.string(),
  account_ref_last4: v.string(),
  notification_sim_iccid: v.string(),
  status: v.picklist(['pending_verification', 'active', 'inactive']),
  version: v.number(),
  notification_sim_index: v.nullable(v.number()),
});

const ScanMessageRow = v.object({
  id: v.string(),
  phone_iccid: v.string(),
  phone_number: v.string(),
  content: v.string(),
  timestamp: v.nullable(v.string()),
  type: v.string(),
});

export type ScanMessage = v.InferOutput<typeof ScanMessageRow>;

const PriorExecutionRow = v.object({
  billing_account_id: v.string(),
  metadata_json: v.string(),
});

export function listBillingAccounts(db: D1<'all'>) {
  return queryAll(
    db.prepare(
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
  );
}

export function listBillingAccountMembers(db: D1<'all'>) {
  return queryAll(
    db.prepare(
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
  );
}

export function listLinkedSims(db: D1<'all'>, billingAccountId: string) {
  return queryAll(
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
      .bind(billingAccountId),
    CarrierBillingLinkedSim,
  );
}

export function findEligibleReceivingSim(
  db: D1<'first'>,
  iccid: string,
): Promise<ReceivingSim | null> {
  return queryFirst(
    db
      .prepare(
        `
    SELECT iccid, sim_index
    FROM device_view
    WHERE iccid = ?
      AND country = 'SG'
      AND carrier = 'Singtel'
      AND service_type = 'postpaid'
  `,
      )
      .bind(iccid),
    ReceivingSimRow,
  );
}

export function findActiveStream(db: D1<'first'>, simIccid: string): Promise<BillingStream | null> {
  return queryFirst(
    db
      .prepare(
        `
    SELECT id, currency, account_ref_digest
    FROM carrier_billing_accounts
    WHERE notification_sim_iccid = ?
      AND status = 'active'
      AND country_code = 'SG'
      AND carrier = 'Singtel'
    LIMIT 1
  `,
      )
      .bind(simIccid),
    BillingStreamRow,
  );
}

export function linkSimToAccount(
  db: D1<'run'>,
  billingAccountId: string,
  simIccid: string,
): Promise<D1RunResult> {
  return db
    .prepare(
      `
      INSERT OR IGNORE INTO carrier_billing_account_sims (
        billing_account_id, sim_iccid, verification_source, verified_at, verified_by
      ) VALUES (?, ?, 'contract_or_bill', CURRENT_TIMESTAMP, 'system:sms')
    `,
    )
    .bind(billingAccountId, simIccid)
    .run();
}

export function insertSingtelAccountIfAbsent(
  db: D1<'run'>,
  account: {
    id: string;
    displayName: string;
    notificationSimIccid: string;
    accountRefDigest: string;
    accountRefLast4: string;
  },
): Promise<D1RunResult> {
  return db
    .prepare(
      `
    INSERT OR IGNORE INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES (?, 'SG', 'Singtel', 'SGD', ?, ?, ?, ?, 'active', 'system:sms')
  `,
    )
    .bind(
      account.id,
      account.displayName,
      account.notificationSimIccid,
      account.accountRefDigest,
      account.accountRefLast4,
    )
    .run();
}

export function listUnprocessedBillMessages(
  db: D1<'all'>,
  billPrefix: string,
  limit: number,
): Promise<ScanMessage[]> {
  return queryAll(
    db
      .prepare(
        `
    SELECT DISTINCT
      m.id,
      m.phone_iccid,
      m.phone_number,
      m.content,
      m.timestamp,
      m.type
    FROM messages m
    INNER JOIN device_view d
      ON d.iccid = m.phone_iccid
      AND d.country = 'SG'
      AND d.carrier = 'Singtel'
      AND d.service_type = 'postpaid'
    WHERE m.type = 'received'
      AND m.phone_number = 'Singtel'
      AND instr(m.content, ?) = 1
      AND NOT EXISTS (
        SELECT 1 FROM carrier_bills b WHERE b.source_message_id = m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM carrier_bill_events e WHERE e.source_message_id = m.id
      )
    ORDER BY m.timestamp DESC, m.id DESC
    LIMIT ?
  `,
      )
      .bind(billPrefix, limit),
    ScanMessageRow,
  );
}

export function findBillableAccount(db: D1<'first'>, accountId: string) {
  return queryFirst(
    db
      .prepare(
        `
    SELECT
      a.id, a.display_name, a.account_ref_digest, a.account_ref_last4,
      a.notification_sim_iccid, a.status, a.version,
      d.sim_index AS notification_sim_index
    FROM carrier_billing_accounts a
    INNER JOIN device_view d
      ON d.iccid = a.notification_sim_iccid
      AND d.country = 'SG'
      AND d.carrier = 'Singtel'
      AND d.service_type = 'postpaid'
    WHERE a.id = ?
      AND a.status = 'active'
      AND a.country_code = 'SG'
      AND a.carrier = 'Singtel'
      AND EXISTS (
        SELECT 1 FROM carrier_billing_account_sims s
        WHERE s.billing_account_id = a.id
          AND s.sim_iccid = a.notification_sim_iccid
          AND s.removed_at IS NULL
      )
  `,
      )
      .bind(accountId),
    BillableAccountRow,
  );
}

export function listBackfillMessages(
  db: D1<'all'>,
  simIccid: string,
  billPrefix: string,
  fragmentSuffix: string,
): Promise<ScanMessage[]> {
  return queryAll(
    db
      .prepare(
        `
    SELECT id, phone_iccid, phone_number, content, timestamp, type
    FROM messages
    WHERE phone_iccid = ?
      AND phone_number = 'Singtel'
      AND type = 'received'
      AND (instr(content, ?) = 1 OR trim(content) = ?)
    ORDER BY timestamp, id
  `,
      )
      .bind(simIccid, billPrefix, fragmentSuffix),
    ScanMessageRow,
  );
}

export function findPriorBackfillExecution(db: D1<'first'>, actor: string, idempotencyKey: string) {
  return queryFirst(
    db
      .prepare(
        `
      SELECT billing_account_id, metadata_json
      FROM carrier_billing_account_events
      WHERE actor_subject = ? AND idempotency_key = ?
    `,
      )
      .bind(actor, idempotencyKey),
    PriorExecutionRow,
  );
}

export function insertBackfillExecutedEvent(
  db: D1<'run'>,
  event: {
    id: string;
    billingAccountId: string;
    actor: string;
    idempotencyKey: string;
    metadata: string;
  },
): Promise<D1RunResult> {
  return db
    .prepare(
      `
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject,
        idempotency_key, metadata_json
      ) VALUES (?, ?, 'backfill_executed', ?, ?, ?)
    `,
    )
    .bind(event.id, event.billingAccountId, event.actor, event.idempotencyKey, event.metadata)
    .run();
}
