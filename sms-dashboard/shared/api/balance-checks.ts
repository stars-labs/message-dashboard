import * as v from 'valibot';
import {
  CHECK_STATUSES,
  DISPLAY_STATUSES,
  SKILL_JOB_STATUSES,
  WEB_JOB_STATUSES,
} from '../balance-status.js';

/** sim_balance_profiles.method, as the table's CHECK constraint lists it. */
export const PROFILE_METHODS = ['sms', 'ussd', 'api', 'browser'] as const;

/** A balance figure parsed from a carrier reply. */
export const BalanceMetric = v.object({
  metric_type: v.string(),
  value: v.nullable(v.number()),
  unit: v.nullable(v.string()),
  currency: v.nullable(v.string()),
  expires_at: v.nullable(v.string()),
});

export type BalanceMetric = v.InferOutput<typeof BalanceMetric>;

/** A balance check as GET /api/balance-checks lists it, with its messages and parsed metrics. */
export const BalanceCheck = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  requested_at: v.string(),
  sent_at: v.nullable(v.string()),
  completed_at: v.nullable(v.string()),
  status: v.picklist(CHECK_STATUSES),
  step_index: v.number(),
  response_sender: v.nullable(v.string()),
  raw_response: v.nullable(v.string()),
  error: v.nullable(v.string()),
  parser_version: v.string(),
  country_code: v.string(),
  profile_carrier: v.string(),
  method: v.picklist(PROFILE_METHODS),
  command: v.string(),
  destination: v.nullable(v.string()),
  conversation_steps: v.string(),
  sim_index: v.nullable(v.number()),
  sim_number: v.nullable(v.string()),
  sim_carrier: v.nullable(v.string()),
  sim_country: v.nullable(v.string()),
  outbound_content: v.nullable(v.string()),
  outbound_recipient: v.nullable(v.string()),
  outbound_timestamp: v.nullable(v.string()),
  outbound_status: v.nullable(v.string()),
  response_content: v.nullable(v.string()),
  response_phone_number: v.nullable(v.string()),
  response_timestamp: v.nullable(v.string()),
  skill_job_status: v.nullable(v.picklist(SKILL_JOB_STATUSES)),
  web_job_status: v.nullable(v.picklist(WEB_JOB_STATUSES)),
  web_human_reason: v.nullable(v.string()),
  display_status: v.picklist(DISPLAY_STATUSES),
  profile_outputs: v.array(v.string()),
  metrics: v.array(BalanceMetric),
});

export type BalanceCheck = v.InferOutput<typeof BalanceCheck>;

export const BalanceChecksResponse = v.object({
  success: v.literal(true),
  data: v.array(BalanceCheck),
});

export type BalanceChecksResponse = v.InferOutput<typeof BalanceChecksResponse>;

/** Where a balance check stands, as GET /api/balance-checks/status reports it for polling. */
const BalanceCheckStatus = v.object({
  id: v.string(),
  status: v.picklist(CHECK_STATUSES),
  updated_at: v.string(),
  completed_at: v.nullable(v.string()),
  skill_job_status: v.nullable(v.picklist(SKILL_JOB_STATUSES)),
  web_job_status: v.nullable(v.picklist(WEB_JOB_STATUSES)),
  web_human_reason: v.nullable(v.string()),
  display_status: v.picklist(DISPLAY_STATUSES),
});

export const BalanceCheckStatusResponse = v.object({
  success: v.literal(true),
  data: v.array(BalanceCheckStatus),
});

export type BalanceCheckStatusResponse = v.InferOutput<typeof BalanceCheckStatusResponse>;

/** One message a balance check sent or received. */
export const BalanceConversationMessage = v.object({
  id: v.string(),
  type: v.nullable(v.picklist(['sent', 'received'])),
  content: v.string(),
  timestamp: v.nullable(v.string()),
  status: v.nullable(v.string()),
  phone_number: v.nullable(v.string()),
  recipient: v.nullable(v.string()),
});

export type BalanceConversationMessage = v.InferOutput<typeof BalanceConversationMessage>;

/** One step the Balance Agent reported while it worked a carrier website. */
export const BalanceWebEvent = v.object({
  id: v.number(),
  event_type: v.string(),
  detail_json: v.string(),
  created_at: v.string(),
});

/** GET /api/balance-checks/:id: the messages and web events of one check. */
const BalanceCheckDetail = v.object({
  id: v.string(),
  conversation: v.array(BalanceConversationMessage),
  web_events: v.array(BalanceWebEvent),
});

export const BalanceCheckDetailResponse = v.object({
  success: v.literal(true),
  data: BalanceCheckDetail,
});

export type BalanceCheckDetailResponse = v.InferOutput<typeof BalanceCheckDetailResponse>;
