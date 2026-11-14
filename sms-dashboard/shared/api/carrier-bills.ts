import * as v from 'valibot';
import { CarrierBillingLinkedSim, CarrierBillingNotificationSim } from './carrier-billing.js';

/** carrier_bills.action_status: what the operator has done about a bill. */
const BILL_ACTION_STATUSES = [
  'unpaid',
  'payment_planned',
  'paid',
  'waived',
  'needs_review',
] as const;

/** How pressing a bill is, derived from its action status and due date. */
export const BILL_URGENCIES = [
  'needs_review',
  'paid',
  'waived',
  'overdue',
  'due_soon',
  'open',
] as const;

/** A carrier bill with its account, notification SIM, and urgency. */
export const CarrierBill = v.object({
  id: v.string(),
  billing_account_id: v.string(),
  source_message_id: v.nullable(v.string()),
  amount_minor: v.number(),
  currency: v.string(),
  due_date: v.string(),
  received_at: v.string(),
  parser_version: v.string(),
  action_status: v.picklist(BILL_ACTION_STATUSES),
  payment_planned_at: v.nullable(v.string()),
  paid_at: v.nullable(v.string()),
  paid_by: v.nullable(v.string()),
  operator_note: v.nullable(v.string()),
  version: v.number(),
  created_at: v.string(),
  updated_at: v.string(),
  account_display_name: v.string(),
  carrier: v.string(),
  notification_sim_iccid: v.string(),
  linked_sim_count: v.number(),
  account_ref_masked: v.string(),
  notification_sim: CarrierBillingNotificationSim,
  urgency: v.picklist(BILL_URGENCIES),
  days_remaining: v.number(),
});

export type CarrierBill = v.InferOutput<typeof CarrierBill>;

/** GET /api/carrier-bills. */
export const CarrierBillsResponse = v.object({
  success: v.literal(true),
  today: v.string(),
  bills: v.array(CarrierBill),
});

export type CarrierBillsResponse = v.InferOutput<typeof CarrierBillsResponse>;

/** The message a bill was parsed from. */
export const CarrierBillSourceMessage = v.object({
  id: v.string(),
  sender: v.nullable(v.string()),
  content: v.string(),
  timestamp: v.nullable(v.string()),
});

/** One audited change to a bill; the metadata is the JSON the server stored with it. */
export const CarrierBillEvent = v.object({
  id: v.string(),
  event_type: v.string(),
  actor_type: v.string(),
  actor_subject: v.nullable(v.string()),
  source_message_id: v.nullable(v.string()),
  created_at: v.string(),
  metadata: v.unknown(),
});

/** A carrier bill with its linked SIMs, source message, and audit events. */
const CarrierBillDetail = v.object({
  ...CarrierBill.entries,
  linked_sims: v.array(CarrierBillingLinkedSim),
  source_message: v.nullable(CarrierBillSourceMessage),
  events: v.array(CarrierBillEvent),
});

/** GET /api/carrier-bills/:id. */
export const CarrierBillResponse = v.object({
  success: v.literal(true),
  bill: CarrierBillDetail,
});

export type CarrierBillResponse = v.InferOutput<typeof CarrierBillResponse>;
