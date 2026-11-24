import * as v from 'valibot';
import { bodyObject } from './body.js';
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

export const QUERY_METHODS = ['sms', 'browser'] as const;

export const BATCH_METHODS = ['direct_sms', 'sms_ai', 'browser'] as const;

export const INELIGIBLE_REASONS = [
  'secondary',
  'offline',
  'unsupported',
  'unverified',
  'service_type',
  'cooldown',
] as const;

export const BalanceMetric = v.object({
  metric_type: v.string(),
  value: v.nullable(v.number()),
  unit: v.nullable(v.string()),
  currency: v.nullable(v.string()),
  expires_at: v.nullable(v.string()),
});

export type BalanceMetric = v.InferOutput<typeof BalanceMetric>;

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

/** The limit is clamped by the handler, which keeps any text. */
export const BalanceChecksQuery = v.object({
  phone_iccid: v.optional(v.string()),
  limit: v.optional(v.string()),
});

/** Comma-separated check ids, checked by the handler. */
export const BalanceCheckStatusQuery = v.object({ ids: v.optional(v.string()) });

export const BalanceChecksResponse = v.object({
  success: v.literal(true),
  data: v.array(BalanceCheck),
});

export type BalanceChecksResponse = v.InferOutput<typeof BalanceChecksResponse>;

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

export const BalanceWebEvent = v.object({
  id: v.number(),
  event_type: v.string(),
  detail_json: v.string(),
  created_at: v.string(),
});

export const BalanceCheckDetail = v.object({
  id: v.string(),
  conversation: v.array(BalanceConversationMessage),
  web_events: v.array(BalanceWebEvent),
});

export type BalanceCheckDetail = v.InferOutput<typeof BalanceCheckDetail>;

export const BalanceCheckDetailResponse = v.object({
  success: v.literal(true),
  data: BalanceCheckDetail,
});

export type BalanceCheckDetailResponse = v.InferOutput<typeof BalanceCheckDetailResponse>;

export const BalanceMethod = v.object({
  category: v.picklist([...BATCH_METHODS, 'unsupported']),
  capability: v.nullable(v.picklist(RUNNER_CAPABILITIES)),
  interactive: v.boolean(),
});

export type BalanceMethod = v.InferOutput<typeof BalanceMethod>;

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
};

/** Keys are in the order the Worker writes them. */
export const QueuedBalanceCheck = v.union([
  v.object({
    ...QueuedCheckBase,
    method: v.literal('sms'),
    profile_carrier: v.string(),
    outbound_message_id: v.string(),
  }),
  v.object({
    ...QueuedCheckBase,
    method: v.literal('browser'),
    profile_carrier: v.string(),
    web_job_id: v.string(),
  }),
]);

export type QueuedBalanceCheck = v.InferOutput<typeof QueuedBalanceCheck>;

// The ops scripts' /api/control/balance-checks routes: their messages are recorded in
// shared/control-fixtures/ops/.
const INVALID_JSON = 'Invalid JSON body';
const CHECK_REQUIRED = 'phone_iccid and profile_id are required';
const CHECK_ID_REQUIRED = 'check_id is required';

export const BalanceCheckCreateBody = bodyObject(
  { phone_iccid: v.string(CHECK_REQUIRED), profile_id: v.string(CHECK_REQUIRED) },
  { phone_iccid: CHECK_REQUIRED, profile_id: CHECK_REQUIRED },
  CHECK_REQUIRED,
  INVALID_JSON,
);

export const BalanceCheckCreateResponse = v.object({
  success: v.literal(true),
  check: QueuedBalanceCheck,
});

export type BalanceCheckCreateResponse = v.InferOutput<typeof BalanceCheckCreateResponse>;

export const BalanceCheckIdBody = bodyObject(
  { check_id: v.string(CHECK_ID_REQUIRED) },
  { check_id: CHECK_ID_REQUIRED },
  CHECK_ID_REQUIRED,
  INVALID_JSON,
);

export const BalanceCheckStepResponse = v.object({
  success: v.literal(true),
  check: v.object({
    id: v.string(),
    status: v.literal('queued'),
    step_index: v.number(),
    outbound_message_id: v.string(),
  }),
});

export type BalanceCheckStepResponse = v.InferOutput<typeof BalanceCheckStepResponse>;

export const BalanceCheckStopResponse = v.object({
  success: v.literal(true),
  check: v.object({ id: v.string(), status: v.picklist(['timed_out', 'unparsed']) }),
});

export type BalanceCheckStopResponse = v.InferOutput<typeof BalanceCheckStopResponse>;

export const BalanceQueryResponse = v.object({
  success: v.literal(true),
  check: BalanceCheck,
});

export type BalanceQueryResponse = v.InferOutput<typeof BalanceQueryResponse>;

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
  checks: v.array(BalanceCheck),
  failures: v.array(
    v.object({
      phone_iccid: v.string(),
      sim_index: v.number(),
      error: v.string(),
    }),
  ),
});

export type BalanceQueryBatchResponse = v.InferOutput<typeof BalanceQueryBatchResponse>;

export const RecentBalanceCheck = v.object({
  sim_iccid: v.string(),
  profile_id: v.string(),
  id: v.string(),
  status: v.picklist(CHECK_STATUSES),
  requested_at: v.string(),
});

export type RecentBalanceCheck = v.InferOutput<typeof RecentBalanceCheck>;

export const BalanceQueryRefusal = v.object({
  reason: v.picklist(INELIGIBLE_REASONS),
  previous_check: v.nullable(RecentBalanceCheck),
});

const SCOPE_REQUIRED = 'A unique non-empty SIM scope is required';
const METHODS_REQUIRED = 'A unique list of supported methods is required';
export const PHONE_ICCID_REQUIRED = 'phone_iccid is required';

const MAX_BATCH_SCOPE = 500;

function unique(items: readonly unknown[]): boolean {
  return new Set(items).size === items.length;
}

const Scope = v.pipe(
  v.array(
    v.pipe(
      v.string(SCOPE_REQUIRED),
      v.trim(),
      v.minLength(1, SCOPE_REQUIRED),
      v.maxLength(64, SCOPE_REQUIRED),
    ),
    SCOPE_REQUIRED,
  ),
  v.minLength(1, SCOPE_REQUIRED),
  v.maxLength(MAX_BATCH_SCOPE, SCOPE_REQUIRED),
  v.check((iccids) => unique(iccids), SCOPE_REQUIRED),
);

export const BalanceQueryPreviewBody = bodyObject(
  { phone_iccids: Scope },
  { phone_iccids: SCOPE_REQUIRED },
  SCOPE_REQUIRED,
);

export const BalanceQueryPreflightQuery = v.object({ phone_iccid: v.optional(v.string()) });

export const BalanceQueryBody = bodyObject(
  {
    phone_iccid: v.pipe(v.string(PHONE_ICCID_REQUIRED), v.minLength(1, PHONE_ICCID_REQUIRED)),
  },
  { phone_iccid: PHONE_ICCID_REQUIRED },
  PHONE_ICCID_REQUIRED,
);

/** The methods are checked before the scope. */
export const BalanceQueryBatchBody = bodyObject(
  {
    methods: v.pipe(
      v.array(v.picklist(BATCH_METHODS, METHODS_REQUIRED), METHODS_REQUIRED),
      v.minLength(1, METHODS_REQUIRED),
      v.check((methods) => unique(methods), METHODS_REQUIRED),
    ),
    phone_iccids: Scope,
  },
  { methods: METHODS_REQUIRED, phone_iccids: SCOPE_REQUIRED },
  METHODS_REQUIRED,
);

export type BalanceQueryRefusal = v.InferOutput<typeof BalanceQueryRefusal>;
