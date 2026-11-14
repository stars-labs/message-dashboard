import * as v from 'valibot';
import {
  CHECK_STATUSES,
  DISPLAY_STATUSES,
  SKILL_JOB_STATUSES,
  WEB_JOB_STATUSES,
} from '../balance-status.js';
import {
  BalanceRunnerCapabilities,
  BalanceRunnerCapabilitySummary,
  RUNNER_CAPABILITIES,
} from './balance-runners.js';

/** sim_balance_profiles.method, as the table's CHECK constraint lists it. */
export const PROFILE_METHODS = ['sms', 'ussd', 'api', 'browser'] as const;

/** The sim_balance_profiles.method values the query planner can run. */
export const QUERY_METHODS = ['sms', 'browser'] as const;

/** The ways a batch can query a SIM: plain SMS, SMS with the AI skill, or the carrier website. */
export const BATCH_METHODS = ['direct_sms', 'sms_ai', 'browser'] as const;

/** Why a SIM cannot be queried now. */
export const INELIGIBLE_REASONS = [
  'secondary',
  'offline',
  'unsupported',
  'unverified',
  'service_type',
  'cooldown',
] as const;

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

/** How a profile is queried, and the runner capability it needs. */
export const BalanceMethod = v.object({
  category: v.picklist([...BATCH_METHODS, 'unsupported']),
  capability: v.nullable(v.picklist(RUNNER_CAPABILITIES)),
  interactive: v.boolean(),
});

export type BalanceMethod = v.InferOutput<typeof BalanceMethod>;

/** GET /api/balance-checks/query-preflight: whether one SIM can be queried now, and how. */
export const BalanceQueryPreflightResponse = v.object({
  success: v.literal(true),
  eligible: v.boolean(),
  reason: v.nullable(v.picklist(INELIGIBLE_REASONS)),
  phone: v.object({
    iccid: v.string(),
    sim_index: v.number(),
    number: v.string(),
    carrier: v.nullable(v.string()),
  }),
  profile: v.nullable(
    v.object({
      id: v.string(),
      method: v.picklist(QUERY_METHODS),
      carrier: v.string(),
    }),
  ),
  method: BalanceMethod,
  runner: v.union([
    v.object({
      required: v.literal(false),
      available: v.literal(true),
      state: v.literal('not_required'),
    }),
    v.object({ required: v.literal(true), ...BalanceRunnerCapabilitySummary.entries }),
  ]),
});

export type BalanceQueryPreflightResponse = v.InferOutput<typeof BalanceQueryPreflightResponse>;

/** How many SIMs a query plan covers, and how many fell into each ineligible reason. */
const BalanceQueryPlanSummary = v.object({
  total: v.number(),
  eligible: v.number(),
  offline: v.number(),
  unsupported: v.number(),
  unverified: v.number(),
  cooldown: v.number(),
  secondary: v.number(),
  service_type: v.number(),
});

/** POST /api/balance-checks/query-preview: the SIMs a batch would query, counted by method. */
export const BalanceQueryPreviewResponse = v.object({
  success: v.literal(true),
  summary: BalanceQueryPlanSummary,
  method_summary: v.object({
    direct_sms: v.number(),
    sms_ai: v.number(),
    browser: v.number(),
  }),
  runner_capabilities: BalanceRunnerCapabilities,
  eligible: v.array(
    v.object({
      phone_iccid: v.string(),
      sim_index: v.number(),
      phone_number: v.string(),
      carrier: v.nullable(v.string()),
      profile_id: v.string(),
      category: v.picklist(BATCH_METHODS),
      capability: v.nullable(v.picklist(RUNNER_CAPABILITIES)),
      interactive: v.boolean(),
    }),
  ),
});

export type BalanceQueryPreviewResponse = v.InferOutput<typeof BalanceQueryPreviewResponse>;

const QueuedCheckBase = {
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  status: v.literal('queued'),
  requested_at: v.string(),
  profile_carrier: v.string(),
};

/** A balance check just queued: an SMS check names its outbound message, a browser check its web job. */
export const QueuedBalanceCheck = v.union([
  v.object({
    ...QueuedCheckBase,
    method: v.literal('sms'),
    outbound_message_id: v.string(),
  }),
  v.object({
    ...QueuedCheckBase,
    method: v.literal('browser'),
    web_job_id: v.string(),
  }),
]);

export type QueuedBalanceCheck = v.InferOutput<typeof QueuedBalanceCheck>;

/** POST /api/balance-checks/query. */
export const BalanceQueryResponse = v.object({
  success: v.literal(true),
  check: QueuedBalanceCheck,
});

export type BalanceQueryResponse = v.InferOutput<typeof BalanceQueryResponse>;

/** POST /api/balance-checks/query-batch: the checks queued, and the SIMs that failed to queue. */
export const BalanceQueryBatchResponse = v.object({
  success: v.literal(true),
  batch_id: v.string(),
  summary: v.object({
    ...BalanceQueryPlanSummary.entries,
    selected: v.number(),
    methods: v.array(v.picklist(BATCH_METHODS)),
    queued: v.number(),
    failed_to_queue: v.number(),
  }),
  checks: v.array(QueuedBalanceCheck),
  failures: v.array(
    v.object({
      phone_iccid: v.string(),
      sim_index: v.number(),
      error: v.string(),
    }),
  ),
});

export type BalanceQueryBatchResponse = v.InferOutput<typeof BalanceQueryBatchResponse>;
