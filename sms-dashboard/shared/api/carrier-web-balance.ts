import * as v from 'valibot';

/** The portal configuration a job carries; each provider reads its own fields. */
const CarrierWebBalanceSkill = v.looseObject({
  id: v.string(),
  query_origin: v.optional(v.unknown()),
  query_endpoint: v.optional(v.unknown()),
  balance_url: v.optional(v.unknown()),
  human_verification_timeout_seconds: v.optional(v.number()),
  cooldown_seconds: v.optional(v.number()),
});

/** GET /api/control/carrier-web-balance/jobs/claim, when a job was leased. */
export const CarrierWebBalanceJob = v.object({
  id: v.string(),
  check_id: v.string(),
  sim_iccid: v.string(),
  sim_number: v.nullable(v.string()),
  sim_index: v.nullable(v.number()),
  login_url: v.string(),
  otp_requested_at: v.nullable(v.string()),
  skill: CarrierWebBalanceSkill,
});

export type CarrierWebBalanceJob = v.InferOutput<typeof CarrierWebBalanceJob>;

/** Where the runner stopped reading candidate messages; the next poll starts after it. */
const OtpCursor = v.object({ created_at: v.string(), source_message_id: v.string() });

/** GET /api/control/carrier-web-balance/jobs/:id/otp, when the job is leased and its code was requested. */
export const CarrierWebBalanceOtpResponse = v.object({
  code: v.fallback(v.nullish(v.string()), null),
  cursor: v.fallback(v.optional(OtpCursor), undefined),
});

export type CarrierWebBalanceOtpResponse = v.InferOutput<typeof CarrierWebBalanceOtpResponse>;
