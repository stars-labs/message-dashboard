import { json } from '../lib/response.js';
import { nanoid } from 'nanoid';
import * as v from 'valibot';
import { parseJson, type Parsed, type Schema } from '../../shared/parse-json.js';
import {
  D1_MAX_BOUND_PARAMETERS,
  queryAll,
  queryFirst,
  type D1,
  type D1Batch,
  type D1RunResult,
  type D1Statement,
} from '../lib/d1.js';
import { NOT_JSON_MESSAGE, readBody, type MissingKeyMessages } from '../lib/request-body.js';
import { secretMatches } from '../lib/secret.js';
import { parseBalanceSkillConfig } from '../utils/balance-skill.js';
import {
  CHECK_STATUSES,
  SKILL_JOB_STATUSES,
  WEB_JOB_STATUSES,
  type CheckStatus,
  type DisplayStatus,
  type SkillJobStatus,
  type WebJobStatus,
} from '../../shared/balance-status.js';
import {
  BATCH_METHODS,
  BalanceConversationMessage,
  BalanceMetric,
  BalanceWebEvent,
  INELIGIBLE_REASONS,
  PROFILE_METHODS,
  QUERY_METHODS,
  type BalanceMethod,
  type BalanceQueryBatchResponse,
  type BalanceQueryPreflightResponse,
  type BalanceQueryPreviewResponse,
  type BalanceQueryResponse,
  type BalanceCheck,
  type QueuedBalanceCheck,
  type BalanceCheckDetailResponse,
  type BalanceCheckStatusResponse,
  type BalanceChecksResponse,
} from '../../shared/api/balance-checks.js';
import { errorText } from '../../shared/error-text.js';
import { senderMatches } from '../utils/spam-filter.js';
import { loadBalanceRunnerStatus } from './balance-runners.js';
import {
  createCarrierWebBalanceStatements,
  newCarrierWebBalanceIds,
} from './carrier-web-balance.js';

/** The three send outcomes the daemon reports for an outbound SMS. */
export type SmsOutcome = 'confirmed' | 'submitted_unconfirmed' | 'failed';
type BatchMethod = (typeof BATCH_METHODS)[number];
type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

const Flag = v.picklist([0, 1]);

/** A row of device_view as the balance planner reads it. */
const PlanPhoneRow = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  country: v.nullable(v.string()),
  sim_status: v.string(),
  sim_index: v.number(),
  sim_role: v.string(),
  service_type: v.string(),
});

export type PlanPhone = v.InferOutput<typeof PlanPhoneRow>;

const PROFILE_COLUMNS = `id, country_code, carrier, method, command, destination, expected_senders,
  parser_version, response_window_minutes, discovery_enabled, enabled, conversation_steps,
  skill_config`;

const profileColumns = {
  id: v.string(),
  country_code: v.string(),
  carrier: v.string(),
  command: v.string(),
  destination: v.nullable(v.string()),
  expected_senders: v.string(),
  parser_version: v.string(),
  response_window_minutes: v.number(),
  discovery_enabled: Flag,
  enabled: Flag,
  conversation_steps: v.string(),
  skill_config: v.string(),
};

/** A sim_balance_profiles row of any method. */
const ProfileRow = v.object({ ...profileColumns, method: v.picklist(PROFILE_METHODS) });

/** A sim_balance_profiles row whose method the planner can run. */
const QueryProfileRow = v.object({ ...profileColumns, method: v.picklist(QUERY_METHODS) });

export type BalanceProfile = v.InferOutput<typeof QueryProfileRow>;

const RecentCheckRow = v.object({
  sim_iccid: v.string(),
  profile_id: v.string(),
  id: v.string(),
  status: v.picklist(CHECK_STATUSES),
  requested_at: v.string(),
});

const ParsedCheckRow = v.object({ sim_iccid: v.string(), profile_id: v.string() });

type RecentCheck = v.InferOutput<typeof RecentCheckRow>;
type ParsedCheck = v.InferOutput<typeof ParsedCheckRow>;

/** One SIM's balance-query eligibility. An eligible SIM always has a profile. */
type PlanItem =
  | {
      phone: PlanPhone;
      profile: BalanceProfile;
      eligible: true;
      reason: null;
      recentCheck: null;
    }
  | {
      phone: PlanPhone;
      profile: BalanceProfile | null;
      eligible: false;
      reason: IneligibleReason;
      recentCheck: RecentCheck | null;
    };

type EligiblePlanItem = Extract<PlanItem, { eligible: true }>;

/** A message handed to the balancer: what was received, from whom. */
interface BalanceMessage {
  id: string;
  phone_number: string | null;
  content: string;
}

/** The fields of a balance check a follow-up SMS is queued from. */
interface FollowUpCheck {
  id: string;
  sim_number: string | null;
  destination: string | null;
  step_index: number;
}

/**
 * A pending check as reply correlation reads it. The query only returns checks
 * whose deadline the reply arrived before, so the window flag is never null.
 */
const PendingCheckRow = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  parser_version: v.string(),
  step_index: v.number(),
  status: v.picklist(CHECK_STATUSES),
  expected_senders: v.string(),
  conversation_steps: v.string(),
  skill_config: v.string(),
  destination: v.nullable(v.string()),
  sim_number: v.nullable(v.string()),
  response_window_open: Flag,
});

export type BalanceCheckRow = v.InferOutput<typeof PendingCheckRow>;

const ConversationStep = v.object({ command: v.string(), response_contains: v.string() });
const AttemptedStep = v.object({ command: v.string() });
const SkillOutputs = v.object({ outputs: v.array(v.unknown()) });
const RequiredServiceType = v.object({ required_service_type: v.pipe(v.string(), v.nonEmpty()) });

const CHINA_MOBILE_NAMES = ['china mobile', 'cmcc', '中国移动', '移动'];
const CHINA_UNICOM_NAMES = ['china unicom', 'unicom', '中国联通', '联通'];
const CHINA_TELECOM_NAMES = ['china telecom', 'telecom', 'ctcc', '中国电信', '电信'];
const CMHK_NAMES = ['cmhk', 'china mobile hong kong', '中国移动香港', '中移香港', '香港移动'];
const MAX_BATCH_SCOPE = 500;
const BALANCE_COOLDOWN_PREDICATE = `
  status IN ('queued', 'awaiting_response')
  OR (status IN ('response_received', 'parsed', 'unparsed')
    AND datetime(requested_at) >= datetime('now', '-24 hours'))
`;

/**
 * The cash balance patterns of each SMS parser, in order of preference.
 * China Telecom reports both 当前号码总余额 (total account balance) and
 * 当前可用余额 (available balance); 总余额 includes prepaid amounts and is the
 * canonical figure the Telecom app shows. 当前号码通用余额 is the older format
 * that omits 总余额.
 */
const CASH_BALANCE_PATTERNS = new Map<string, readonly RegExp[]>([
  [
    'cn-telecom-balance-v1',
    [
      /当前号码总余额(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/,
      /(?:当前可用余额|当前号码通用余额)(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/,
    ],
  ],
  [
    'cn-mobile-balance-v1',
    [/(?:账户|话费|可用)?余额(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/],
  ],
]);

const INVALID_JSON = 'Invalid JSON body';
const SCOPE_REQUIRED = 'A unique non-empty SIM scope is required';
const METHODS_REQUIRED = 'A unique list of supported methods is required';
const PHONE_ICCID_REQUIRED = 'phone_iccid is required';
const CHECK_REQUIRED = 'phone_iccid and profile_id are required';
const CHECK_ID_REQUIRED = 'check_id is required';
const NOT_ELIGIBLE = 'SIM is not eligible for a balance query';

const INELIGIBLE_ERRORS: Readonly<Record<IneligibleReason, string>> = {
  offline: 'SIM is not active',
  unsupported: 'No balance query profile matches this SIM',
  unverified: 'Balance query profile is not verified for this SIM',
  cooldown: 'This SIM has already been queried in the last 24 hours',
  secondary: NOT_ELIGIBLE,
  service_type: NOT_ELIGIBLE,
};

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

const PreviewBody = v.object({ phone_iccids: Scope }, SCOPE_REQUIRED);

const PREVIEW_MISSING_KEY_MESSAGES = {
  phone_iccids: SCOPE_REQUIRED,
} as const satisfies MissingKeyMessages<typeof PreviewBody>;

const QueryBody = v.object(
  {
    phone_iccid: v.pipe(v.string(PHONE_ICCID_REQUIRED), v.minLength(1, PHONE_ICCID_REQUIRED)),
  },
  PHONE_ICCID_REQUIRED,
);

const QUERY_MISSING_KEY_MESSAGES = {
  phone_iccid: PHONE_ICCID_REQUIRED,
} as const satisfies MissingKeyMessages<typeof QueryBody>;

const BatchBody = v.object(
  {
    methods: v.pipe(
      v.array(v.picklist(BATCH_METHODS, METHODS_REQUIRED), METHODS_REQUIRED),
      v.minLength(1, METHODS_REQUIRED),
      v.check((methods) => unique(methods), METHODS_REQUIRED),
    ),
    phone_iccids: Scope,
  },
  METHODS_REQUIRED,
);

const BATCH_MISSING_KEY_MESSAGES = {
  methods: METHODS_REQUIRED,
  phone_iccids: SCOPE_REQUIRED,
} as const satisfies MissingKeyMessages<typeof BatchBody>;

const CreateBody = v.object(
  { phone_iccid: v.string(CHECK_REQUIRED), profile_id: v.string(CHECK_REQUIRED) },
  CHECK_REQUIRED,
);

const CREATE_MISSING_KEY_MESSAGES = {
  phone_iccid: CHECK_REQUIRED,
  profile_id: CHECK_REQUIRED,
} as const satisfies MissingKeyMessages<typeof CreateBody>;

const CheckIdBody = v.object({ check_id: v.string(CHECK_ID_REQUIRED) }, CHECK_ID_REQUIRED);

const CHECK_ID_MISSING_KEY_MESSAGES = {
  check_id: CHECK_ID_REQUIRED,
} as const satisfies MissingKeyMessages<typeof CheckIdBody>;

const CheckStatusSchema = v.picklist(CHECK_STATUSES);
const SkillJobStatusSchema = v.nullable(v.picklist(SKILL_JOB_STATUSES));
const WebJobStatusSchema = v.nullable(v.picklist(WEB_JOB_STATUSES));

const ListRow = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  requested_at: v.string(),
  sent_at: v.nullable(v.string()),
  completed_at: v.nullable(v.string()),
  status: CheckStatusSchema,
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
  skill_config: v.string(),
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
  skill_job_status: SkillJobStatusSchema,
  web_job_status: WebJobStatusSchema,
  web_human_reason: v.nullable(v.string()),
  metrics_json: v.string(),
});

const StatusRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  updated_at: v.string(),
  completed_at: v.nullable(v.string()),
  skill_job_status: SkillJobStatusSchema,
  web_job_status: WebJobStatusSchema,
  web_human_reason: v.nullable(v.string()),
});

const IdRow = v.object({ id: v.string() });

const CheckPhoneRow = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  country: v.nullable(v.string()),
  sim_status: v.string(),
});

const CooldownRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  requested_at: v.string(),
});

const ContinueRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  step_index: v.number(),
  response_message_id: v.nullable(v.string()),
  response_sender: v.nullable(v.string()),
  raw_response: v.nullable(v.string()),
  destination: v.nullable(v.string()),
  conversation_steps: v.string(),
  sim_number: v.nullable(v.string()),
});

const RetryRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  step_index: v.number(),
  destination: v.nullable(v.string()),
  conversation_steps: v.string(),
  message_id: v.string(),
  message_content: v.string(),
  message_recipient: v.nullable(v.string()),
  message_status: v.nullable(v.string()),
});

const StopRow = v.object({ id: v.string(), status: CheckStatusSchema });

interface ListRequest {
  url: string;
  env: { DB: D1<'all'> };
}

interface DetailRequest {
  params?: Record<string, string>;
  env: { DB: D1<'first' | 'all'> };
}

interface PlanRequest {
  url: string;
  method: string;
  user?: { id: string };
  env: { DB: D1<'all'> };
  text(): Promise<string>;
}

interface QueueRequest {
  user?: { id: string };
  env: { DB: D1<'all' | 'run'> & D1Batch<'run'> };
  text(): Promise<string>;
}

interface ControlRequest {
  headers: { get(name: string): string | null };
  env: { API_KEY?: string; DB: D1<'first' | 'run'> & D1Batch<'run'> };
  text(): Promise<string>;
}

function badRequest(error: string): Response {
  return json({ success: false, error }, 400);
}

/** A batch statement that changed no row lost a race with another writer. */
function changed(result: D1RunResult | undefined): boolean {
  return result !== undefined && result.meta.changes > 0;
}

/** readBody, answering a body that is not JSON with this API's own message. */
async function readBalanceBody<S extends v.GenericSchema>(
  request: { text(): Promise<string> },
  schema: S,
  missingKeyMessages: MissingKeyMessages<S>,
): Promise<Parsed<v.InferOutput<S>>> {
  const body = await readBody(request, schema, missingKeyMessages);
  return body.ok || body.error !== NOT_JSON_MESSAGE ? body : { ok: false, error: INVALID_JSON };
}

function hasApiKey(request: ControlRequest): Promise<boolean> {
  return secretMatches(request.headers.get('X-API-Key'), request.env.API_KEY);
}

function normalizeCarrier(value: string | null): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function checkKey(simIccid: string, profileId: string): string {
  return `${simIccid}\u0000${profileId}`;
}

function requiredServiceType(profile: BalanceProfile): string | null {
  const parsed = parseJson(profile.skill_config, RequiredServiceType);
  return parsed.ok ? parsed.value.required_service_type : null;
}

function profileOutputs(skillConfig: string): string[] {
  const parsed = parseJson(skillConfig, SkillOutputs);
  return parsed.ok
    ? parsed.value.outputs.filter((output): output is string => typeof output === 'string')
    : [];
}

function parseMetrics(metricsJson: string): BalanceMetric[] {
  const parsed = parseJson(metricsJson, v.array(BalanceMetric));
  return parsed.ok ? parsed.value : [];
}

function webDisplayStatus(status: WebJobStatus): DisplayStatus | null {
  switch (status) {
    case 'pending':
      return 'web_pending';
    case 'leased':
      return 'web_processing';
    case 'awaiting_otp':
      return 'web_otp';
    case 'authenticating':
      return 'web_authenticating';
    case 'querying':
      return 'web_querying';
    case 'human_verification_required':
      return 'web_human_required';
    case 'completed':
    case 'failed':
    case 'stopped':
      return null;
  }
}

function displayBalanceStatus(record: {
  status: CheckStatus;
  skill_job_status: SkillJobStatus | null;
  web_job_status: WebJobStatus | null;
}): DisplayStatus {
  if (
    (record.status === 'response_received' || record.status === 'unparsed') &&
    (record.skill_job_status === 'pending' || record.skill_job_status === 'leased')
  ) {
    return record.skill_job_status === 'leased' ? 'skill_processing' : 'skill_pending';
  }
  if (record.status === 'queued' && record.web_job_status !== null) {
    return webDisplayStatus(record.web_job_status) ?? record.status;
  }
  return record.status;
}

export function buildBalanceQueryPlan({
  phones,
  profiles,
  recentChecks = [],
  successfulChecks = [],
  allowDiscovery = false,
}: {
  phones: readonly PlanPhone[];
  profiles: readonly BalanceProfile[];
  recentChecks?: readonly RecentCheck[];
  successfulChecks?: readonly ParsedCheck[];
  allowDiscovery?: boolean;
}): PlanItem[] {
  const recentBySim = new Map(recentChecks.map((check) => [check.sim_iccid, check]));
  const successful = new Set(
    successfulChecks.map((check) => checkKey(check.sim_iccid, check.profile_id)),
  );

  return phones.map((phone): PlanItem => {
    const matchingProfiles = profiles
      .filter(
        (profile) =>
          phone.country === profile.country_code &&
          carrierMatchesProfile(phone.carrier, profile.carrier),
      )
      .sort((a, b) => b.enabled - a.enabled);
    const profile =
      matchingProfiles.find(
        (candidate) =>
          candidate.enabled === 1 ||
          (candidate.discovery_enabled === 1 &&
            (allowDiscovery || successful.has(checkKey(phone.iccid, candidate.id)))),
      ) ?? null;
    const recentCheck = recentBySim.get(phone.iccid) ?? null;
    const ineligible = (reason: IneligibleReason): PlanItem => ({
      phone,
      profile,
      eligible: false,
      reason,
      recentCheck,
    });

    if (phone.sim_role === 'secondary') return ineligible('secondary');
    if (phone.sim_status !== 'active') return ineligible('offline');
    if (!profile) return ineligible(matchingProfiles.length ? 'unverified' : 'unsupported');
    const serviceType = requiredServiceType(profile);
    if (serviceType !== null && phone.service_type !== serviceType) {
      return ineligible('service_type');
    }
    if (recentCheck) return ineligible('cooldown');
    return { phone, profile, eligible: true, reason: null, recentCheck: null };
  });
}

function summarizePlan(plan: readonly PlanItem[]) {
  const summary = {
    total: plan.length,
    eligible: 0,
    offline: 0,
    unsupported: 0,
    unverified: 0,
    cooldown: 0,
    secondary: 0,
    service_type: 0,
  };
  for (const item of plan) {
    if (item.eligible) summary.eligible += 1;
    else summary[item.reason] += 1;
  }
  return summary;
}

function queryMethod(
  profile: Pick<BalanceProfile, 'method' | 'skill_config'>,
): BalanceMethod & { category: BatchMethod } {
  switch (profile.method) {
    case 'browser':
      return { category: 'browser', capability: 'carrier_browser', interactive: true };
    case 'sms':
      return parseBalanceSkillConfig(profile.skill_config)
        ? { category: 'sms_ai', capability: 'sms_ai', interactive: false }
        : { category: 'direct_sms', capability: null, interactive: false };
  }
}

export function describeBalanceMethod(
  profile: Pick<BalanceProfile, 'method' | 'skill_config'> | null,
): BalanceMethod {
  return profile
    ? queryMethod(profile)
    : { category: 'unsupported', capability: null, interactive: false };
}

function summarizeMethods(plan: readonly PlanItem[]): Record<BatchMethod, number> {
  const summary = { direct_sms: 0, sms_ai: 0, browser: 0 };
  for (const item of plan) {
    if (item.eligible) summary[queryMethod(item.profile).category] += 1;
  }
  return summary;
}

export function filterBalancePlanByMethods(
  plan: readonly PlanItem[],
  methods: readonly BatchMethod[],
): EligiblePlanItem[] {
  const selected = new Set(methods);
  return plan.filter(
    (item): item is EligiblePlanItem =>
      item.eligible && selected.has(queryMethod(item.profile).category),
  );
}

/** The SIMs in scope, by index; a scope larger than D1 binds is read in chunks. */
async function loadPlanPhones(
  db: D1<'all'>,
  scope: readonly string[] | null,
): Promise<PlanPhone[]> {
  const select = `
    SELECT iccid, number, carrier, country, sim_status, sim_index, sim_role, service_type
    FROM device_view`;
  if (scope === null) {
    return queryAll(db.prepare(`${select} ORDER BY sim_index`), PlanPhoneRow);
  }
  const phones: PlanPhone[] = [];
  for (let start = 0; start < scope.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = scope.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const where = `WHERE iccid IN (${chunk.map(() => '?').join(', ')})`;
    phones.push(...(await queryAll(db.prepare(`${select} ${where}`).bind(...chunk), PlanPhoneRow)));
  }
  return phones.sort((a, b) => a.sim_index - b.sim_index);
}

async function loadBalanceQueryPlan(
  db: D1<'all'>,
  { scope, allowDiscovery = false }: { scope: readonly string[] | null; allowDiscovery?: boolean },
): Promise<PlanItem[]> {
  const [phones, profiles, recentChecks, successfulChecks] = await Promise.all([
    loadPlanPhones(db, scope),
    queryAll(
      db.prepare(
        `
      SELECT ${PROFILE_COLUMNS} FROM sim_balance_profiles
      WHERE method IN ('sms', 'browser')
        AND (discovery_enabled = 1 OR enabled = 1)
      ORDER BY enabled DESC, id
    `,
      ),
      QueryProfileRow,
    ),
    queryAll(
      db.prepare(
        `
      SELECT sim_iccid, profile_id, id, status, requested_at
      FROM sim_balance_checks
      WHERE ${BALANCE_COOLDOWN_PREDICATE}
      ORDER BY datetime(requested_at) DESC
    `,
      ),
      RecentCheckRow,
    ),
    queryAll(
      db.prepare(
        `
      SELECT DISTINCT sim_iccid, profile_id
      FROM sim_balance_checks
      WHERE status = 'parsed'
    `,
      ),
      ParsedCheckRow,
    ),
  ]);

  return buildBalanceQueryPlan({
    phones,
    profiles,
    recentChecks,
    successfulChecks,
    allowDiscovery,
  });
}

type QueuedProfile = Pick<
  BalanceProfile,
  'id' | 'method' | 'carrier' | 'command' | 'destination' | 'parser_version' | 'skill_config'
>;

async function queueBalanceCheck(
  db: D1<'run'> & D1Batch<'run'>,
  { phone, profile }: { phone: Pick<PlanPhone, 'iccid' | 'number'>; profile: QueuedProfile },
  requestedBySubject: string | null,
): Promise<QueuedBalanceCheck> {
  const requestedAt = new Date().toISOString();
  if (profile.method === 'browser') {
    const { checkId, jobId } = newCarrierWebBalanceIds();
    await db.batch(
      createCarrierWebBalanceStatements(db, {
        checkId,
        jobId,
        phone,
        profile,
        requestedBySubject,
      }),
    );
    return {
      id: checkId,
      sim_iccid: phone.iccid,
      profile_id: profile.id,
      status: 'queued',
      requested_at: requestedAt,
      method: profile.method,
      profile_carrier: profile.carrier,
      web_job_id: jobId,
    };
  }

  const checkId = `bal-${nanoid()}`;
  const messageId = `msg-balance-${nanoid()}`;

  await db.batch([
    db
      .prepare(
        `
      INSERT INTO sim_balance_checks (
        id, sim_iccid, profile_id, status, outbound_message_id, parser_version,
        requested_by_subject
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?)
    `,
      )
      .bind(
        checkId,
        phone.iccid,
        profile.id,
        messageId,
        profile.parser_version,
        requestedBySubject,
      ),
    db
      .prepare(
        `
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, timestamp, type, recipient,
        status, filter_status, purpose, balance_check_id
      ) VALUES (
        ?, ?, ?, ?, CURRENT_TIMESTAMP, 'sent', ?,
        'sending', 'filtered', 'balance_maintenance', ?
      )
    `,
      )
      .bind(messageId, phone.iccid, phone.number, profile.command, profile.destination, checkId),
  ]);

  return {
    id: checkId,
    sim_iccid: phone.iccid,
    profile_id: profile.id,
    status: 'queued',
    requested_at: requestedAt,
    method: profile.method,
    profile_carrier: profile.carrier,
    outbound_message_id: messageId,
  };
}

/** The conversation step at `index`, if it exists and has the shape `schema` requires. */
function stepAt<T>(conversationSteps: string, index: number, schema: Schema<T>): T | null {
  const steps = parseJson(conversationSteps, v.array(v.unknown()));
  if (!steps.ok) return null;
  const step = v.safeParse(schema, steps.value[index]);
  return step.success ? step.output : null;
}

function matchingNextStep(
  check: { conversation_steps: string; step_index: number },
  content: string,
): { command: string } | null {
  const step = stepAt(check.conversation_steps, check.step_index, ConversationStep);
  return step && content.includes(step.response_contains) ? step : null;
}

function attemptedStep(check: {
  conversation_steps: string;
  step_index: number;
}): { command: string } | null {
  const stepIndex = check.step_index - 1;
  return stepIndex < 0 ? null : stepAt(check.conversation_steps, stepIndex, AttemptedStep);
}

export function parseBalanceMetrics(parserVersion: string, content: string): BalanceMetric[] {
  for (const pattern of CASH_BALANCE_PATTERNS.get(parserVersion) ?? []) {
    const amount = pattern.exec(content)?.[1];
    if (amount !== undefined) {
      return [
        {
          metric_type: 'cash_balance',
          value: Number(amount),
          unit: null,
          currency: 'CNY',
          expires_at: null,
        },
      ];
    }
  }
  return [];
}

export function carrierMatchesProfile(
  actualCarrier: string | null,
  profileCarrier: string,
): boolean {
  const actual = normalizeCarrier(actualCarrier);
  const expected = normalizeCarrier(profileCarrier);
  if (!actual || !expected) return false;
  if (actual === expected) return true;

  if (CHINA_MOBILE_NAMES.includes(expected)) {
    return CHINA_MOBILE_NAMES.some((name) => actual.includes(name));
  }

  if (CHINA_UNICOM_NAMES.includes(expected)) {
    return CHINA_UNICOM_NAMES.some((name) => actual.includes(name));
  }

  if (CHINA_TELECOM_NAMES.includes(expected)) {
    return CHINA_TELECOM_NAMES.some((name) => actual.includes(name));
  }

  if (CMHK_NAMES.includes(expected)) {
    return CMHK_NAMES.some((name) => actual.includes(name)) || actual === '移动';
  }

  return actual.includes(expected) || expected.includes(actual);
}

export function expectedSenderMatches(rawSender: string, expectedSendersJson: string): boolean {
  const expected = parseJson(expectedSendersJson, v.array(v.unknown()));
  return expected.ok && expected.value.some((sender) => senderMatches(rawSender, sender));
}

export async function findPendingBalanceCheck(
  db: D1<'all'>,
  {
    phone_iccid,
    phone_number,
    message_timestamp = new Date().toISOString(),
  }: { phone_iccid: string; phone_number: string; message_timestamp?: string },
): Promise<BalanceCheckRow | null> {
  if (!phone_iccid || !phone_number) return null;

  const candidates = await queryAll(
    db
      .prepare(
        `
    SELECT
      c.id,
      c.sim_iccid,
      c.profile_id,
      c.parser_version,
      c.step_index,
      c.status,
      p.expected_senders,
      p.conversation_steps,
      p.skill_config,
      p.destination,
      dv.number AS sim_number,
      datetime('now') <= datetime(c.deadline_at)
        AS response_window_open
    FROM sim_balance_checks c
    JOIN sim_balance_profiles p ON p.id = c.profile_id
    LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
    WHERE c.sim_iccid = ?
      AND c.status IN ('queued', 'awaiting_response', 'failed', 'timed_out')
      AND datetime(?) >= datetime(COALESCE((
        SELECT MAX(m.timestamp)
        FROM messages m
        WHERE m.balance_check_id = c.id AND m.type = 'sent'
      ), c.sent_at, c.requested_at))
      AND datetime(?) <= datetime(c.deadline_at)
    ORDER BY c.requested_at DESC
  `,
      )
      .bind(phone_iccid, message_timestamp, message_timestamp),
    PendingCheckRow,
  );

  return (
    candidates.find((candidate) =>
      expectedSenderMatches(phone_number, candidate.expected_senders),
    ) ?? null
  );
}

/** The fields of a message the daemon uploads that multipart grouping reads. */
interface UploadedPart {
  id?: unknown;
  content?: unknown;
  phone_iccid?: unknown;
  phone_number?: unknown;
  timestamp?: unknown;
}

function keyPart(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

// A carrier reply can arrive as several SMS parts. In text mode the daemon cannot
// read the concatenation header, so each part is uploaded as its own message and
// the parts of one reply share a sender and an arrival timestamp.
//
// Without this grouping the first part processed claims the check and finalizes it
// on a fragment, so a balance carried by a later part is never parsed.
//
// Parts carry no sequence number, so batch order is the only ordering available.
// Both consumers search for a substring, so concatenation order is not significant.
export function mergeMultipartReplies(
  messages: readonly UploadedPart[],
): Map<string, { key: string; content: string }> {
  const groups = new Map<string, { id: string; content: string }[]>();
  for (const message of messages) {
    const id = keyPart(message.id);
    const content = keyPart(message.content);
    if (!id || !content) continue;
    const key = [
      keyPart(message.phone_iccid),
      keyPart(message.phone_number),
      keyPart(message.timestamp),
    ].join('\0');
    const entry = { id, content };
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const merged = new Map<string, { key: string; content: string }>();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const content = group.map((message) => message.content).join('');
    for (const message of group) merged.set(message.id, { key, content });
  }
  return merged;
}

export async function linkBalanceReply(
  db: D1<'run'> & D1Batch<'run'>,
  check: BalanceCheckRow,
  message: BalanceMessage,
  { mergedContent = null }: { mergedContent?: string | null } = {},
): Promise<{ queued: boolean; message_id: string | null } | { linked: boolean }> {
  // A merged reply is parsed as one message; otherwise the raw part is used.
  const content = mergedContent ?? message.content;
  const nextStep = matchingNextStep(check, content);
  const responseWindowOpen = check.response_window_open === 1;
  if (nextStep && responseWindowOpen) {
    return queueBalanceFollowUp(db, check, message, nextStep, check.status);
  }

  const metrics = parseBalanceMetrics(check.parser_version, content);
  const statements: D1Statement<'run'>[] = [
    db
      .prepare(
        `
    UPDATE sim_balance_checks
    SET status = ?,
        completed_at = CURRENT_TIMESTAMP,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status IN ('queued', 'awaiting_response', 'failed', 'timed_out')
  `,
      )
      .bind(
        metrics.length ? 'parsed' : 'response_received',
        message.id,
        message.phone_number,
        content,
        check.id,
      ),
  ];

  for (const metric of metrics) {
    statements.push(
      db
        .prepare(
          `
      INSERT INTO sim_balance_metrics (
        check_id, metric_type, value, unit, currency, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(check_id, metric_type) DO UPDATE SET
        value = excluded.value,
        unit = excluded.unit,
        currency = excluded.currency,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `,
        )
        .bind(
          check.id,
          metric.metric_type,
          metric.value,
          metric.unit,
          metric.currency,
          metric.expires_at,
        ),
    );
  }

  const skill = parseBalanceSkillConfig(check.skill_config);
  if (!metrics.length && skill && responseWindowOpen && check.step_index < skill.max_turns) {
    statements.push(
      db
        .prepare(
          `
      INSERT OR IGNORE INTO sim_balance_skill_jobs (
        id, check_id, response_message_id, step_index
      )
      SELECT ?, id, ?, step_index
      FROM sim_balance_checks
      WHERE id = ?
        AND status = 'response_received'
        AND response_message_id = ?
    `,
        )
        .bind(`skill-${nanoid()}`, message.id, check.id, message.id),
    );
  }

  statements.push(
    db
      .prepare(
        `
    UPDATE messages
    SET purpose = 'balance_maintenance',
        balance_check_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND (balance_check_id IS NULL OR balance_check_id = ?)
      AND EXISTS (
        SELECT 1
        FROM sim_balance_checks c
        WHERE c.id = ?
          AND c.response_message_id = messages.id
      )
  `,
      )
      .bind(check.id, message.id, check.id, check.id),
  );

  const [update] = await db.batch(statements);
  return { linked: changed(update) };
}

export async function expireStaleBalanceChecks(
  db: D1<'run'> & D1Batch<'run'>,
): Promise<{ expired: number; stopped_jobs: number }> {
  const [checks, jobs] = await db.batch([
    db.prepare(
      `
      UPDATE sim_balance_checks
      SET status = 'timed_out',
          completed_at = CURRENT_TIMESTAMP,
          error = 'No reply received within the configured response window',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'awaiting_response'
        AND deadline_at < CURRENT_TIMESTAMP
    `,
    ),
    db.prepare(
      `
      UPDATE sim_balance_skill_jobs
      SET status = 'stopped',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Balance response window expired'),
          updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'leased')
        AND EXISTS (
          SELECT 1
          FROM sim_balance_checks c
          WHERE c.id = sim_balance_skill_jobs.check_id
            AND c.status = 'timed_out'
        )
    `,
    ),
  ]);

  return {
    expired: checks?.meta.changes ?? 0,
    stopped_jobs: jobs?.meta.changes ?? 0,
  };
}

export async function queueBalanceFollowUp(
  db: D1<'run'> & D1Batch<'run'>,
  check: FollowUpCheck,
  message: BalanceMessage,
  step: { command: string },
  fromStatus: CheckStatus,
  extraStatements: readonly D1Statement<'run'>[] = [],
): Promise<{ queued: boolean; message_id: string | null }> {
  const messageId = `msg-balance-${nanoid()}`;
  const [insert] = await db.batch([
    db
      .prepare(
        `
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, timestamp, type, recipient,
        status, filter_status, purpose, balance_check_id
      )
      SELECT ?, c.sim_iccid, ?, ?, CURRENT_TIMESTAMP, 'sent', ?,
        'sending', 'filtered', 'balance_maintenance', c.id
      FROM sim_balance_checks c
      WHERE c.id = ? AND c.status = ? AND c.step_index = ?
    `,
      )
      .bind(
        messageId,
        check.sim_number,
        step.command,
        check.destination,
        check.id,
        fromStatus,
        check.step_index,
      ),
    db
      .prepare(
        `
    UPDATE sim_balance_checks
    SET status = 'queued',
        step_index = step_index + 1,
        completed_at = NULL,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        deadline_at = NULL,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = ?
      AND step_index = ?
    `,
      )
      .bind(
        message.id,
        message.phone_number,
        message.content,
        check.id,
        fromStatus,
        check.step_index,
      ),
    ...extraStatements,
  ]);

  const queued = changed(insert);
  return { queued, message_id: queued ? messageId : null };
}

export async function updateBalanceCheckForSmsResult(
  db: D1<'run'>,
  messageId: string,
  outcome: SmsOutcome,
  errorMessage: string | null = null,
): Promise<void> {
  const submitted = outcome === 'confirmed' || outcome === 'submitted_unconfirmed';
  const failure = errorMessage === null || errorMessage === '' ? 'SMS send failed' : errorMessage;
  await db
    .prepare(
      `
    UPDATE sim_balance_checks
    SET status = ?,
        sent_at = CASE WHEN ? THEN COALESCE(sent_at, CURRENT_TIMESTAMP) ELSE sent_at END,
        deadline_at = CASE WHEN ? THEN datetime(
          CURRENT_TIMESTAMP,
          '+' || (SELECT p.response_window_minutes
                  FROM sim_balance_profiles p
                  WHERE p.id = sim_balance_checks.profile_id) || ' minutes'
        ) ELSE deadline_at END,
        completed_at = CASE WHEN ? THEN completed_at ELSE CURRENT_TIMESTAMP END,
        error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT balance_check_id FROM messages WHERE id = ?
    )
      AND status = 'queued'
  `,
    )
    .bind(
      submitted ? 'awaiting_response' : 'failed',
      submitted ? 1 : 0,
      submitted ? 1 : 0,
      submitted ? 1 : 0,
      submitted ? null : failure,
      messageId,
    )
    .run();
}

/** Balance checks as the list shows them, newest first. */
async function loadBalanceChecks(
  db: D1<'all'>,
  { where, params, limit }: { where: string; params: string[]; limit: number },
): Promise<BalanceCheck[]> {
  const rows = await queryAll(
    db
      .prepare(
        `
      SELECT
        c.id,
        c.sim_iccid,
        c.profile_id,
        c.requested_at,
        c.sent_at,
        c.completed_at,
        c.status,
        c.step_index,
        c.response_sender,
        c.raw_response,
        c.error,
        c.parser_version,
        p.country_code,
        p.carrier AS profile_carrier,
        p.method,
        p.command,
        p.destination,
        p.conversation_steps,
        p.skill_config,
        dv.sim_index,
        dv.number AS sim_number,
        dv.carrier AS sim_carrier,
        dv.country AS sim_country,
        om.content AS outbound_content,
        om.recipient AS outbound_recipient,
        om.timestamp AS outbound_timestamp,
        om.status AS outbound_status,
        rm.content AS response_content,
        rm.phone_number AS response_phone_number,
        rm.timestamp AS response_timestamp,
        (
          SELECT sj.status
          FROM sim_balance_skill_jobs sj
          WHERE sj.check_id = c.id
          ORDER BY sj.created_at DESC, sj.rowid DESC
          LIMIT 1
        ) AS skill_job_status,
        (
          SELECT wj.status
          FROM sim_balance_web_jobs wj
          WHERE wj.check_id = c.id
          LIMIT 1
        ) AS web_job_status,
        (
          SELECT wj.human_reason
          FROM sim_balance_web_jobs wj
          WHERE wj.check_id = c.id
          LIMIT 1
        ) AS web_human_reason,
        COALESCE((
          SELECT json_group_array(json_object(
            'metric_type', bm.metric_type,
            'value', bm.value,
            'unit', bm.unit,
            'currency', bm.currency,
            'expires_at', bm.expires_at
          ))
          FROM sim_balance_metrics bm
          WHERE bm.check_id = c.id
        ), '[]') AS metrics_json
      FROM sim_balance_checks c
      JOIN sim_balance_profiles p ON p.id = c.profile_id
      LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
      LEFT JOIN messages om ON om.id = c.outbound_message_id
      LEFT JOIN messages rm ON rm.id = c.response_message_id
      ${where}
      ORDER BY c.requested_at DESC
      LIMIT ?
    `,
      )
      .bind(...params, limit),
    ListRow,
  );

  return rows.map(({ metrics_json, skill_config, ...record }) => ({
    ...record,
    display_status: displayBalanceStatus(record),
    profile_outputs: profileOutputs(skill_config),
    metrics: parseMetrics(metrics_json),
  }));
}

/** The checks just queued, as the list shows them, in the order they were queued. */
async function loadQueuedChecks(db: D1<'all'>, ids: readonly string[]): Promise<BalanceCheck[]> {
  const byId = new Map<string, BalanceCheck>();
  const chunkSize = D1_MAX_BOUND_PARAMETERS - 1;
  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize);
    const checks = await loadBalanceChecks(db, {
      where: `WHERE c.id IN (${chunk.map(() => '?').join(', ')})`,
      params: chunk,
      limit: chunk.length,
    });
    for (const check of checks) byId.set(check.id, check);
  }
  return ids.map((id) => {
    const check = byId.get(id);
    if (check === undefined) throw new Error(`Queued balance check ${id} is missing`);
    return check;
  });
}

export const balanceQueriesHandler = {
  async list(request: ListRequest): Promise<Response> {
    const url = new URL(request.url);
    const phoneIccid = url.searchParams.get('phone_iccid');
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 100;
    const conditions: string[] = [];
    const params: string[] = [];

    if (phoneIccid) {
      conditions.push('c.sim_iccid = ?');
      params.push(phoneIccid);
    }

    const checks = await loadBalanceChecks(request.env.DB, {
      where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
      limit,
    });

    return json({ success: true, data: checks } satisfies BalanceChecksResponse);
  },

  async status(request: ListRequest): Promise<Response> {
    const ids = [
      ...new Set(
        (new URL(request.url).searchParams.get('ids') ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length || ids.length > 100 || ids.some((id) => id.length > 200)) {
      return json({ error: 'ids must contain 1 to 100 balance check IDs' }, 400);
    }
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await queryAll(
      request.env.DB.prepare(
        `
      SELECT c.id, c.status, c.updated_at, c.completed_at,
        (SELECT sj.status FROM sim_balance_skill_jobs sj
         WHERE sj.check_id = c.id ORDER BY sj.created_at DESC, sj.rowid DESC LIMIT 1)
          AS skill_job_status,
        wj.status AS web_job_status,
        wj.human_reason AS web_human_reason
      FROM sim_balance_checks c
      LEFT JOIN sim_balance_web_jobs wj ON wj.check_id = c.id
      WHERE c.id IN (${placeholders})
    `,
      ).bind(...ids),
      StatusRow,
    );
    return json({
      success: true,
      data: rows.map((record) => ({
        ...record,
        display_status: displayBalanceStatus(record),
      })),
    } satisfies BalanceCheckStatusResponse);
  },

  async detail(request: DetailRequest): Promise<Response> {
    const id = (request.params?.['id'] ?? '').trim();
    if (!id || id.length > 200) return json({ error: 'Invalid balance check ID' }, 400);
    const check = await queryFirst(
      request.env.DB.prepare(
        `
      SELECT id FROM sim_balance_checks WHERE id = ?
    `,
      ).bind(id),
      IdRow,
    );
    if (!check) return json({ error: 'Balance check not found' }, 404);
    const [conversation, webEvents] = await Promise.all([
      queryAll(
        request.env.DB.prepare(
          `
        SELECT id, type, content, timestamp, status, phone_number, recipient
        FROM messages
        WHERE balance_check_id = ?
        ORDER BY timestamp, id
      `,
        ).bind(id),
        BalanceConversationMessage,
      ),
      queryAll(
        request.env.DB.prepare(
          `
        SELECT e.id, e.event_type, e.detail_json, e.created_at
        FROM sim_balance_web_events e
        JOIN sim_balance_web_jobs j ON j.id = e.job_id
        WHERE j.check_id = ?
        ORDER BY e.created_at, e.id
      `,
        ).bind(id),
        BalanceWebEvent,
      ),
    ]);
    return json({
      success: true,
      data: { id, conversation, web_events: webEvents },
    } satisfies BalanceCheckDetailResponse);
  },

  async preview(request: PlanRequest): Promise<Response> {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    let scope: string[] | null = null;
    if (request.method === 'POST') {
      const body = await readBalanceBody(request, PreviewBody, PREVIEW_MISSING_KEY_MESSAGES);
      if (!body.ok) return badRequest(body.error);
      scope = body.value.phone_iccids;
    }
    const [plan, runners] = await Promise.all([
      loadBalanceQueryPlan(request.env.DB, { scope }),
      loadBalanceRunnerStatus(request.env.DB, requestedBySubject),
    ]);
    return json({
      success: true,
      summary: summarizePlan(plan),
      method_summary: summarizeMethods(plan),
      runner_capabilities: runners.capabilities,
      eligible: plan
        .filter((item): item is EligiblePlanItem => item.eligible)
        .map((item) => ({
          phone_iccid: item.phone.iccid,
          sim_index: item.phone.sim_index,
          phone_number: item.phone.number,
          carrier: item.phone.carrier,
          profile_id: item.profile.id,
          ...queryMethod(item.profile),
        })),
    } satisfies BalanceQueryPreviewResponse);
  },

  async preflight(request: PlanRequest): Promise<Response> {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    const phoneIccid = new URL(request.url).searchParams.get('phone_iccid')?.trim();
    if (!phoneIccid) return badRequest(PHONE_ICCID_REQUIRED);

    const [items, runners] = await Promise.all([
      loadBalanceQueryPlan(request.env.DB, { scope: [phoneIccid], allowDiscovery: true }),
      loadBalanceRunnerStatus(request.env.DB, requestedBySubject),
    ]);
    const item = items[0];
    if (!item) return json({ success: false, error: 'SIM not found' }, 404);

    const method = describeBalanceMethod(item.profile);
    return json({
      success: true,
      eligible: item.eligible,
      reason: item.reason,
      phone: {
        iccid: item.phone.iccid,
        sim_index: item.phone.sim_index,
        number: item.phone.number,
        carrier: item.phone.carrier,
      },
      profile: item.profile
        ? {
            id: item.profile.id,
            method: item.profile.method,
            carrier: item.profile.carrier,
          }
        : null,
      method,
      runner:
        method.capability === null
          ? { required: false, available: true, state: 'not_required' }
          : { required: true, ...runners.capabilities[method.capability] },
    } satisfies BalanceQueryPreflightResponse);
  },

  async query(request: QueueRequest): Promise<Response> {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    const body = await readBalanceBody(request, QueryBody, QUERY_MISSING_KEY_MESSAGES);
    if (!body.ok) return badRequest(body.error);

    const [item] = await loadBalanceQueryPlan(request.env.DB, {
      scope: [body.value.phone_iccid],
      allowDiscovery: true,
    });
    if (!item) return json({ success: false, error: 'SIM not found' }, 404);
    if (!item.eligible) {
      return json(
        {
          success: false,
          error: INELIGIBLE_ERRORS[item.reason],
          reason: item.reason,
          previous_check: item.recentCheck,
        },
        item.reason === 'cooldown' ? 429 : 409,
      );
    }

    const queued = await queueBalanceCheck(request.env.DB, item, requestedBySubject);
    const [check] = await loadQueuedChecks(request.env.DB, [queued.id]);
    if (check === undefined) throw new Error(`Queued balance check ${queued.id} is missing`);
    return json({ success: true, check } satisfies BalanceQueryResponse, 202);
  },

  async queryBatch(request: QueueRequest): Promise<Response> {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    const body = await readBalanceBody(request, BatchBody, BATCH_MISSING_KEY_MESSAGES);
    if (!body.ok) return badRequest(body.error);
    const { methods, phone_iccids: scope } = body.value;

    const plan = await loadBalanceQueryPlan(request.env.DB, { scope });
    const eligible = filterBalancePlanByMethods(plan, methods);
    const queuedIds: string[] = [];
    const failures: { phone_iccid: string; sim_index: number; error: string }[] = [];

    // Queue on the server, one audited transaction per SIM. The daemon fetch endpoint
    // applies a separate maintenance-message cap, so a fleet action cannot monopolise
    // normal user SMS delivery.
    for (const item of eligible) {
      try {
        queuedIds.push((await queueBalanceCheck(request.env.DB, item, requestedBySubject)).id);
      } catch (error) {
        failures.push({
          phone_iccid: item.phone.iccid,
          sim_index: item.phone.sim_index,
          error: errorText(error),
        });
      }
    }

    const checks = await loadQueuedChecks(request.env.DB, queuedIds);

    return json(
      {
        success: true,
        batch_id: `balance-batch-${nanoid()}`,
        summary: {
          ...summarizePlan(plan),
          selected: eligible.length,
          methods,
          queued: checks.length,
          failed_to_queue: failures.length,
        },
        checks,
        failures,
      } satisfies BalanceQueryBatchResponse,
      202,
    );
  },

  async create(request: ControlRequest): Promise<Response> {
    if (!(await hasApiKey(request))) return json({ error: 'Unauthorized' }, 401);

    const body = await readBalanceBody(request, CreateBody, CREATE_MISSING_KEY_MESSAGES);
    if (!body.ok) return badRequest(body.error);
    const { phone_iccid, profile_id } = body.value;

    const db = request.env.DB;
    const [profile, phone, recent] = await Promise.all([
      queryFirst(
        db
          .prepare(
            `
        SELECT ${PROFILE_COLUMNS} FROM sim_balance_profiles
        WHERE id = ? AND (discovery_enabled = 1 OR enabled = 1)
      `,
          )
          .bind(profile_id),
        ProfileRow,
      ),
      queryFirst(
        db
          .prepare(
            `
        SELECT iccid, number, carrier, country, sim_status
        FROM device_view WHERE iccid = ?
      `,
          )
          .bind(phone_iccid),
        CheckPhoneRow,
      ),
      queryFirst(
        db
          .prepare(
            `
        SELECT id, status, requested_at
        FROM sim_balance_checks
        WHERE sim_iccid = ?
          AND (${BALANCE_COOLDOWN_PREDICATE})
        ORDER BY requested_at DESC LIMIT 1
      `,
          )
          .bind(phone_iccid),
        CooldownRow,
      ),
    ]);

    if (!profile) {
      return json({ success: false, error: 'Balance profile is not enabled' }, 404);
    }
    if (profile.method !== 'sms' && profile.method !== 'browser') {
      return json({ success: false, error: 'Profile method is not implemented' }, 400);
    }
    if (phone?.sim_status !== 'active') {
      return json({ success: false, error: 'SIM is not active' }, 409);
    }
    if (
      phone.country !== profile.country_code ||
      !carrierMatchesProfile(phone.carrier, profile.carrier)
    ) {
      return json({ success: false, error: 'SIM does not match the carrier profile' }, 409);
    }
    if (recent) {
      return json(
        {
          success: false,
          error: 'This SIM has already been queried in the last 24 hours',
          previous_check: recent,
        },
        429,
      );
    }

    const check = await queueBalanceCheck(
      db,
      { phone, profile: { ...profile, method: profile.method } },
      null,
    );

    return json(
      {
        success: true,
        check,
      },
      202,
    );
  },

  async continue(request: ControlRequest): Promise<Response> {
    if (!(await hasApiKey(request))) return json({ error: 'Unauthorized' }, 401);

    const body = await readBalanceBody(request, CheckIdBody, CHECK_ID_MISSING_KEY_MESSAGES);
    if (!body.ok) return badRequest(body.error);

    const check = await queryFirst(
      request.env.DB.prepare(
        `
      SELECT
        c.id, c.status, c.step_index, c.response_message_id,
        c.response_sender, c.raw_response,
        p.destination, p.conversation_steps,
        dv.number AS sim_number
      FROM sim_balance_checks c
      JOIN sim_balance_profiles p ON p.id = c.profile_id
      LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
      WHERE c.id = ?
    `,
      ).bind(body.value.check_id),
      ContinueRow,
    );

    if (!check) return json({ success: false, error: 'Balance check not found' }, 404);
    if (
      (check.status !== 'response_received' && check.status !== 'unparsed') ||
      check.response_message_id === null ||
      check.raw_response === null
    ) {
      return json({ success: false, error: 'Balance check cannot be continued' }, 409);
    }

    const step = matchingNextStep(check, check.raw_response);
    if (!step) {
      return json({ success: false, error: 'No allowlisted next step matches the reply' }, 409);
    }

    const result = await queueBalanceFollowUp(
      request.env.DB,
      check,
      {
        id: check.response_message_id,
        phone_number: check.response_sender,
        content: check.raw_response,
      },
      step,
      check.status,
    );

    if (!result.queued) {
      return json({ success: false, error: 'Balance check changed before it was continued' }, 409);
    }

    return json(
      {
        success: true,
        check: {
          id: check.id,
          status: 'queued',
          step_index: check.step_index + 1,
          outbound_message_id: result.message_id,
        },
      },
      202,
    );
  },

  async retry(request: ControlRequest): Promise<Response> {
    if (!(await hasApiKey(request))) return json({ error: 'Unauthorized' }, 401);

    const body = await readBalanceBody(request, CheckIdBody, CHECK_ID_MISSING_KEY_MESSAGES);
    if (!body.ok) return badRequest(body.error);

    const check = await queryFirst(
      request.env.DB.prepare(
        `
      SELECT
        c.id, c.status, c.step_index,
        p.destination, p.conversation_steps,
        m.id AS message_id, m.content AS message_content,
        m.recipient AS message_recipient, m.status AS message_status
      FROM sim_balance_checks c
      JOIN sim_balance_profiles p ON p.id = c.profile_id
      JOIN messages m ON m.id = (
        SELECT latest.id
        FROM messages latest
        WHERE latest.balance_check_id = c.id
          AND latest.type = 'sent'
          AND latest.purpose = 'balance_maintenance'
        ORDER BY datetime(latest.timestamp) DESC, latest.rowid DESC
        LIMIT 1
      )
      WHERE c.id = ?
    `,
      ).bind(body.value.check_id),
      RetryRow,
    );

    const step = check ? attemptedStep(check) : null;
    if (
      check?.status !== 'failed' ||
      check.message_status !== 'failed' ||
      check.message_content !== step?.command ||
      check.message_recipient !== check.destination
    ) {
      return json({ success: false, error: 'No allowlisted failed step can be retried' }, 409);
    }

    const [message, requeued] = await request.env.DB.batch([
      request.env.DB.prepare(
        `
        UPDATE messages
        SET status = 'sending', error_message = NULL,
            processing_session_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed'
          AND purpose = 'balance_maintenance'
      `,
      ).bind(check.message_id),
      request.env.DB.prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'queued', completed_at = NULL, deadline_at = NULL, error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed' AND step_index = ?
      `,
      ).bind(check.id, check.step_index),
    ]);

    if (!changed(message) || !changed(requeued)) {
      return json({ success: false, error: 'Balance check changed before retry' }, 409);
    }

    return json(
      {
        success: true,
        check: {
          id: check.id,
          status: 'queued',
          step_index: check.step_index,
          outbound_message_id: check.message_id,
        },
      },
      202,
    );
  },

  async stop(request: ControlRequest): Promise<Response> {
    if (!(await hasApiKey(request))) return json({ error: 'Unauthorized' }, 401);

    const body = await readBalanceBody(request, CheckIdBody, CHECK_ID_MISSING_KEY_MESSAGES);
    if (!body.ok) return badRequest(body.error);

    const check = await queryFirst(
      request.env.DB.prepare(
        `
      SELECT id, status FROM sim_balance_checks WHERE id = ?
    `,
      ).bind(body.value.check_id),
      StopRow,
    );
    if (!check) return json({ success: false, error: 'Balance check not found' }, 404);
    if (check.status !== 'awaiting_response' && check.status !== 'response_received') {
      return json({ success: false, error: 'Balance check is not stoppable' }, 409);
    }

    const finalStatus = check.status === 'awaiting_response' ? 'timed_out' : 'unparsed';
    const [stopped] = await request.env.DB.batch([
      request.env.DB.prepare(
        `
        UPDATE sim_balance_checks
        SET status = ?, completed_at = CURRENT_TIMESTAMP,
            error = CASE WHEN ? = 'timed_out' THEN 'Stopped by operator' ELSE error END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?
      `,
      ).bind(finalStatus, finalStatus, check.id, check.status),
      request.env.DB.prepare(
        `
        UPDATE sim_balance_skill_jobs
        SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Stopped by operator'),
            updated_at = CURRENT_TIMESTAMP
        WHERE check_id = ? AND status IN ('pending', 'leased')
      `,
      ).bind(check.id),
    ]);

    if (!changed(stopped)) {
      return json({ success: false, error: 'Balance check changed before stop' }, 409);
    }

    return json({ success: true, check: { id: check.id, status: finalStatus } });
  },
};
