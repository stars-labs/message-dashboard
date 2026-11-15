import * as v from 'valibot';
import { ACTIVE_WEB_JOB_STATUSES } from '../balance-status.js';
import { bodyObject } from './body.js';
import { RUNNER_ID_REQUIRED } from './runner-jobs.js';

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

/**
 * GET .../claim on the wire. The skill is the stored configuration passed on
 * as it is: a record keeps its key order, which an object schema would
 * rewrite. CarrierWebBalanceJob is how the Agent reads it.
 */
export const CarrierWebBalanceJobWire = v.object({
  ...CarrierWebBalanceJob.entries,
  skill: v.pipe(
    v.record(v.string(), v.unknown()),
    v.check((skill) => typeof skill['id'] === 'string', 'skill must have an id'),
  ),
});

export type CarrierWebBalanceJobWire = v.InferOutput<typeof CarrierWebBalanceJobWire>;

/** GET .../otp on the wire: the code, or where the next poll starts when none matched. */
export const CarrierWebBalanceOtpWire = v.union([
  v.object({ code: v.null(), cursor: OtpCursor }),
  v.object({ code: v.string() }),
]);

export type CarrierWebBalanceOtpWire = v.InferOutput<typeof CarrierWebBalanceOtpWire>;

/** ?runner_id=&after_created_at=&after_source_message_id= on an OTP poll. */
export const WebJobOtpQuery = v.object(
  {
    runner_id: v.pipe(v.string(RUNNER_ID_REQUIRED), v.trim()),
    after_created_at: v.optional(v.pipe(v.string(), v.trim()), ''),
    after_source_message_id: v.optional(v.pipe(v.string(), v.trim()), ''),
  },
  RUNNER_ID_REQUIRED,
);

// A job action's body as the contract reads it: runner_id, which picks the
// lease, and the action's own fields unread. The handler reads those with the
// action's Fields schema once the lease holds, so a runner without the lease is
// refused as such whatever else its body gets wrong.
const RunnerId = v.string(RUNNER_ID_REQUIRED);
const Unread = v.optional(v.unknown());
const NEEDS_RUNNER_ID = { runner_id: RUNNER_ID_REQUIRED } as const;

const INVALID_STATUS = 'Invalid web job status';
const INVALID_BALANCE = 'balance is invalid';
const ERROR_NOT_TEXT = 'error must be text';

/** POST .../otp-requested. */
export const WebJobLeaseBody = bodyObject(
  { runner_id: RunnerId },
  NEEDS_RUNNER_ID,
  RUNNER_ID_REQUIRED,
  RUNNER_ID_REQUIRED,
);

/** POST .../heartbeat. */
export const WebJobHeartbeatBody = bodyObject(
  { runner_id: RunnerId, status: Unread, reason: Unread },
  NEEDS_RUNNER_ID,
  RUNNER_ID_REQUIRED,
  RUNNER_ID_REQUIRED,
);

export const WebJobHeartbeatFields = v.object(
  {
    status: v.picklist(ACTIVE_WEB_JOB_STATUSES, INVALID_STATUS),
    reason: v.nullish(v.string('reason must be text')),
  },
  INVALID_STATUS,
);

/** A completion field whose wrong type means the same as its absence: the handler's checks answer it. */
const OptionalText = v.fallback(v.optional(v.string()), undefined);

/** POST .../complete. */
export const WebJobCompleteBody = bodyObject(
  {
    runner_id: RunnerId,
    balance: Unread,
    currency: Unread,
    account_number: Unread,
    expires_at: Unread,
  },
  NEEDS_RUNNER_ID,
  RUNNER_ID_REQUIRED,
  RUNNER_ID_REQUIRED,
);

export const WebJobCompleteFields = v.object(
  {
    balance: v.pipe(
      v.number(INVALID_BALANCE),
      v.minValue(-100000, INVALID_BALANCE),
      v.maxValue(1000000, INVALID_BALANCE),
    ),
    currency: OptionalText,
    account_number: OptionalText,
    expires_at: OptionalText,
  },
  INVALID_BALANCE,
);

/** POST .../fail and .../release. */
export const WebJobErrorBody = bodyObject(
  { runner_id: RunnerId, error: Unread },
  NEEDS_RUNNER_ID,
  RUNNER_ID_REQUIRED,
  RUNNER_ID_REQUIRED,
);

export const WebJobErrorFields = v.object(
  { error: v.nullish(v.string(ERROR_NOT_TEXT)) },
  ERROR_NOT_TEXT,
);

export const WebJobActionResponse = v.object({
  success: v.literal(true),
  status: v.picklist(['awaiting_otp', 'parsed', 'failed', 'pending']),
});

export type WebJobActionResponse = v.InferOutput<typeof WebJobActionResponse>;

export const WebJobHeartbeatResponse = v.object({
  success: v.literal(true),
  status: v.picklist(ACTIVE_WEB_JOB_STATUSES),
  lease_seconds: v.number(),
});

export type WebJobHeartbeatResponse = v.InferOutput<typeof WebJobHeartbeatResponse>;
