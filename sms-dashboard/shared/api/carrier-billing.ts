import * as v from 'valibot';
import { bodyObject } from './body.js';

export const CarrierBillingNotificationSim = v.object({
  iccid: v.string(),
  sim_index: v.nullable(v.number()),
  number: v.nullable(v.string()),
});

export type CarrierBillingNotificationSim = v.InferOutput<typeof CarrierBillingNotificationSim>;

export const CarrierBillingLinkedSim = v.object({
  iccid: v.string(),
  sim_index: v.nullable(v.number()),
  number: v.nullable(v.string()),
  verification_source: v.string(),
  verified_at: v.string(),
  verified_by: v.string(),
});

export type CarrierBillingLinkedSim = v.InferOutput<typeof CarrierBillingLinkedSim>;

const CarrierBillingAccount = v.object({
  id: v.string(),
  country_code: v.string(),
  carrier: v.string(),
  currency: v.string(),
  display_name: v.string(),
  account_ref_masked: v.string(),
  status: v.string(),
  version: v.number(),
  payment_due_count: v.number(),
  notification_sim: CarrierBillingNotificationSim,
  linked_sims: v.array(CarrierBillingLinkedSim),
});

export const CarrierBillingAccountsResponse = v.object({
  success: v.literal(true),
  accounts: v.array(CarrierBillingAccount),
});

export type CarrierBillingAccountsResponse = v.InferOutput<typeof CarrierBillingAccountsResponse>;

const ACCOUNT_MESSAGE = 'account_id is required';
const PREVIEW_MESSAGE = 'expected_version must be an integer and preview_digest a string';

const AccountId = v.pipe(v.string(ACCOUNT_MESSAGE), v.nonEmpty(ACCOUNT_MESSAGE));

export const BackfillPreviewBody = bodyObject(
  { account_id: AccountId },
  { account_id: ACCOUNT_MESSAGE },
  ACCOUNT_MESSAGE,
);

export const BackfillExecuteBody = bodyObject(
  {
    account_id: AccountId,
    expected_version: v.pipe(v.number(PREVIEW_MESSAGE), v.integer(PREVIEW_MESSAGE)),
    preview_digest: v.string(PREVIEW_MESSAGE),
  },
  {
    account_id: ACCOUNT_MESSAGE,
    expected_version: PREVIEW_MESSAGE,
    preview_digest: PREVIEW_MESSAGE,
  },
  ACCOUNT_MESSAGE,
);

export const BackfillAccount = v.object({
  id: v.string(),
  display_name: v.string(),
  account_ref_masked: v.string(),
  version: v.number(),
  notification_sim: v.object({ iccid: v.string(), sim_index: v.nullable(v.number()) }),
});

export type BackfillAccount = v.InferOutput<typeof BackfillAccount>;

export const BackfillCandidate = v.object({
  source_message_ids: v.array(v.string()),
  source_kind: v.picklist(['complete', 'reassembled']),
  amount_minor: v.number(),
  currency: v.string(),
  due_date: v.string(),
  received_at: v.nullable(v.string()),
  parser_version: v.string(),
  disposition: v.picklist(['new', 'duplicate', 'conflict', 'already_processed']),
});

export type BackfillCandidate = v.InferOutput<typeof BackfillCandidate>;

export const BackfillSummary = v.object({
  candidates: v.number(),
  complete_messages: v.number(),
  reassembled_messages: v.number(),
  new_bills: v.number(),
  duplicates: v.number(),
  conflicts: v.number(),
  already_processed: v.number(),
});

export type BackfillSummary = v.InferOutput<typeof BackfillSummary>;

export const BackfillPreviewResponse = v.object({
  success: v.literal(true),
  account: BackfillAccount,
  summary: BackfillSummary,
  preview_digest: v.string(),
  candidates: v.array(BackfillCandidate),
});

export type BackfillPreviewResponse = v.InferOutput<typeof BackfillPreviewResponse>;

/** Processing can also report 'ignored' and 'failed'. */
export const BackfillExecuteSummary = v.object({
  detected: v.number(),
  duplicate_detected: v.number(),
  parse_conflict: v.number(),
  already_processed: v.number(),
});

export type BackfillExecuteSummary = v.InferOutput<typeof BackfillExecuteSummary>;

/**
 * A retry with the same key replays the stored summary (null when none was stored). The
 * replay comes first: an object schema drops unnamed keys, so the plain answer would
 * match a replay and lose its idempotent flag.
 */
export const BackfillExecuteResponse = v.union([
  v.object({
    success: v.literal(true),
    idempotent: v.literal(true),
    summary: v.nullable(BackfillExecuteSummary),
  }),
  v.object({ success: v.literal(true), summary: BackfillExecuteSummary }),
]);

export type BackfillExecuteResponse = v.InferOutput<typeof BackfillExecuteResponse>;

export const BackfillVersionConflict = v.object({ current_version: v.number() });

export type BackfillVersionConflict = v.InferOutput<typeof BackfillVersionConflict>;
