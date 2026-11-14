import * as v from 'valibot';

/** The SIM that receives a billing account's bill messages. */
export const CarrierBillingNotificationSim = v.object({
  iccid: v.string(),
  sim_index: v.nullable(v.number()),
  number: v.nullable(v.string()),
});

export type CarrierBillingNotificationSim = v.InferOutput<typeof CarrierBillingNotificationSim>;

/** A SIM verified as belonging to a billing account. */
export const CarrierBillingLinkedSim = v.object({
  iccid: v.string(),
  sim_index: v.nullable(v.number()),
  number: v.nullable(v.string()),
  verification_source: v.string(),
  verified_at: v.string(),
  verified_by: v.string(),
});

export type CarrierBillingLinkedSim = v.InferOutput<typeof CarrierBillingLinkedSim>;

/** A carrier billing account with its notification SIM and linked SIMs. */
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

/** GET /api/carrier-billing/accounts. */
export const CarrierBillingAccountsResponse = v.object({
  success: v.literal(true),
  accounts: v.array(CarrierBillingAccount),
});

export type CarrierBillingAccountsResponse = v.InferOutput<typeof CarrierBillingAccountsResponse>;
