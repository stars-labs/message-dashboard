import { ORPCError } from '@orpc/server';
import { nanoid } from 'nanoid';
import * as v from 'valibot';
import { parseJson, type Schema } from '../../shared/parse-json.js';
import { D1_MAX_BOUND_PARAMETERS, type D1, type D1Batch, type D1Statement } from '../lib/d1.js';
import {
  expireStaleBalanceChecks,
  findBalanceCheckId,
  findBalanceCheckToContinue,
  findBalanceCheckToRetry,
  findBalanceCheckToStop,
  findCheckPhone,
  findEnabledBalanceProfile,
  findRecentBalanceCheck,
  listBalanceCheckMessages,
  listBalanceChecks,
  listBalanceChecksByIds,
  listBalanceCheckStatuses,
  listBalanceCheckWebEvents,
  listCooldownChecks,
  listParsedChecks,
  listPendingChecksForReply,
  listPlanPhones,
  listQueryProfiles,
  markBalanceCheckSmsResult,
  queueBalanceFollowUpMessage,
  queueSmsBalanceCheck,
  recordBalanceReply,
  requeueBalanceCheck,
  runBalanceStatements,
  stopBalanceCheck,
  type BalanceCheckListRow,
  type BalanceCheckRow,
  type BalanceMessage,
  type BalanceProfile,
  type FollowUpCheck,
  type ParsedCheck,
  type PlanPhone,
} from '../db/balance-checks.js';
import { parseBalanceSkillConfig } from '../../shared/balance-skill.js';
import {
  type CheckStatus,
  type DisplayStatus,
  type SkillJobStatus,
  type WebJobStatus,
} from '../../shared/balance-status.js';
import {
  BATCH_METHODS,
  BalanceMetric,
  INELIGIBLE_REASONS,
  type BalanceMethod,
  type BalanceQueryBatchResponse,
  type BalanceQueryPreflightResponse,
  type BalanceQueryPreviewResponse,
  type BalanceQueryResponse,
  type RecentBalanceCheck,
  type BalanceCheck,
  type BalanceQueryRefusal,
  type QueuedBalanceCheck,
  type BalanceCheckDetailResponse,
  type BalanceCheckStatusResponse,
  type BalanceChecksResponse,
  type BalanceCheckStatusQuery,
  type BalanceChecksQuery,
  type BalanceQueryBatchBody,
  type BalanceQueryBody,
  type BalanceQueryPreflightQuery,
  PHONE_ICCID_REQUIRED,
  type BalanceCheckCreateBody,
  type BalanceCheckCreateResponse,
  type BalanceCheckIdBody,
  type BalanceCheckStepResponse,
  type BalanceCheckStopResponse,
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

export type { BalanceCheckRow, BalanceProfile, PlanPhone };

type RecentCheck = RecentBalanceCheck;

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

const ConversationStep = v.object({ command: v.string(), response_contains: v.string() });
const AttemptedStep = v.object({ command: v.string() });
const SkillOutputs = v.object({ outputs: v.array(v.unknown()) });
const RequiredServiceType = v.object({ required_service_type: v.pipe(v.string(), v.nonEmpty()) });

const CHINA_MOBILE_NAMES = ['china mobile', 'cmcc', '中国移动', '移动'];
const CHINA_UNICOM_NAMES = ['china unicom', 'unicom', '中国联通', '联通'];
const CHINA_TELECOM_NAMES = ['china telecom', 'telecom', 'ctcc', '中国电信', '电信'];
const CMHK_NAMES = ['cmhk', 'china mobile hong kong', '中国移动香港', '中移香港', '香港移动'];

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

const NOT_ELIGIBLE = 'SIM is not eligible for a balance query';

const INELIGIBLE_ERRORS: Readonly<Record<IneligibleReason, string>> = {
  offline: 'SIM is not active',
  unsupported: 'No balance query profile matches this SIM',
  unverified: 'Balance query profile is not verified for this SIM',
  cooldown: 'This SIM has already been queried in the last 24 hours',
  secondary: NOT_ELIGIBLE,
  service_type: NOT_ELIGIBLE,
};

interface ReadCall {
  env: { DB: D1<'first' | 'all'> };
}

interface PlanCall {
  user?: { id: string } | undefined;
  env: { DB: D1<'all'> };
}

interface QueueCall {
  user?: { id: string } | undefined;
  env: { DB: D1<'all' | 'run'> & D1Batch<'run'> };
}

/** The signed-in user the route's access already required, as the runner owner and auditor. */
function subjectOf(user: { id: string } | undefined): string {
  if (user === undefined || user.id === '') throw new ORPCError('UNAUTHORIZED');
  return user.id;
}

/** An ops route as the contract hands it over, once the API key has been checked. */
interface OpsCall {
  env: { DB: D1<'first' | 'run'> & D1Batch<'run'> };
}

/** A refusal the ops scripts read as { success: false, error }. */
function refused(
  code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT',
  message: string,
): ORPCError<string, undefined> {
  return new ORPCError(code, { message });
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

async function loadBalanceQueryPlan(
  db: D1<'all'>,
  { scope, allowDiscovery = false }: { scope: readonly string[] | null; allowDiscovery?: boolean },
): Promise<PlanItem[]> {
  const [phones, profiles, recentChecks, successfulChecks] = await Promise.all([
    listPlanPhones(db, scope),
    listQueryProfiles(db),
    listCooldownChecks(db),
    listParsedChecks(db),
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
    await runBalanceStatements(
      db,
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

  await queueSmsBalanceCheck(db, { checkId, messageId, phone, profile, requestedBySubject });

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

  const candidates = await listPendingChecksForReply(db, { phone_iccid, message_timestamp });

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

// In text mode the daemon cannot read the concatenation header, so each part of a
// carrier reply is uploaded as its own message; the parts share sender and arrival
// timestamp. Without grouping, the first part processed finalizes the check on a
// fragment and a balance in a later part is never parsed. Parts carry no sequence
// number, so batch order is the only ordering available.
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
): Promise<FollowUp | { linked: boolean }> {
  const content = mergedContent ?? message.content;
  const nextStep = matchingNextStep(check, content);
  const responseWindowOpen = check.response_window_open === 1;
  if (nextStep && responseWindowOpen) {
    return queueBalanceFollowUp(db, check, message, nextStep, check.status);
  }

  const metrics = parseBalanceMetrics(check.parser_version, content);
  const skill = parseBalanceSkillConfig(check.skill_config);
  const skillJobId =
    !metrics.length && skill && responseWindowOpen && check.step_index < skill.max_turns
      ? `skill-${nanoid()}`
      : null;

  const linked = await recordBalanceReply(db, { check, message, content, metrics, skillJobId });
  return { linked };
}

export { expireStaleBalanceChecks };

/** A follow-up step: queued with its outbound message, or lost to a writer that got there first. */
type FollowUp = { queued: true; message_id: string } | { queued: false; message_id: null };

export async function queueBalanceFollowUp(
  db: D1<'run'> & D1Batch<'run'>,
  check: FollowUpCheck,
  message: BalanceMessage,
  step: { command: string },
  fromStatus: CheckStatus,
  extraStatements: readonly D1Statement<'run'>[] = [],
): Promise<FollowUp> {
  const messageId = `msg-balance-${nanoid()}`;
  const queued = await queueBalanceFollowUpMessage(db, {
    messageId,
    check,
    message,
    step,
    fromStatus,
    extraStatements,
  });

  return queued ? { queued: true, message_id: messageId } : { queued: false, message_id: null };
}

export async function updateBalanceCheckForSmsResult(
  db: D1<'run'>,
  messageId: string,
  outcome: SmsOutcome,
  errorMessage: string | null = null,
): Promise<void> {
  const submitted = outcome === 'confirmed' || outcome === 'submitted_unconfirmed';
  const failure = errorMessage === null || errorMessage === '' ? 'SMS send failed' : errorMessage;
  await markBalanceCheckSmsResult(db, messageId, { submitted, failure });
}

function toBalanceChecks(rows: readonly BalanceCheckListRow[]): BalanceCheck[] {
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
    const checks = toBalanceChecks(await listBalanceChecksByIds(db, chunk));
    for (const check of checks) byId.set(check.id, check);
  }
  return ids.map((id) => {
    const check = byId.get(id);
    if (check === undefined) throw new Error(`Queued balance check ${id} is missing`);
    return check;
  });
}

export const balanceQueriesHandler = {
  async list(
    { env }: ReadCall,
    query: v.InferOutput<typeof BalanceChecksQuery>,
  ): Promise<BalanceChecksResponse> {
    const phoneIccid = query.phone_iccid;
    const requestedLimit = Number.parseInt(query.limit ?? '100', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 100;
    const checks = toBalanceChecks(await listBalanceChecks(env.DB, { phoneIccid, limit }));

    return { success: true, data: checks };
  },

  async status(
    { env }: ReadCall,
    query: v.InferOutput<typeof BalanceCheckStatusQuery>,
  ): Promise<BalanceCheckStatusResponse> {
    const ids = [
      ...new Set(
        (query.ids ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length || ids.length > 100 || ids.some((id) => id.length > 200)) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'ids must contain 1 to 100 balance check IDs',
      });
    }
    const rows = await listBalanceCheckStatuses(env.DB, ids);
    return {
      success: true,
      data: rows.map((record) => ({
        ...record,
        display_status: displayBalanceStatus(record),
      })),
    };
  },

  async detail({ env }: ReadCall, rawId: string): Promise<BalanceCheckDetailResponse> {
    const id = rawId.trim();
    if (!id || id.length > 200) {
      throw new ORPCError('BAD_REQUEST', { message: 'Invalid balance check ID' });
    }
    const check = await findBalanceCheckId(env.DB, id);
    if (!check) throw new ORPCError('NOT_FOUND', { message: 'Balance check not found' });
    const [conversation, webEvents] = await Promise.all([
      listBalanceCheckMessages(env.DB, id),
      listBalanceCheckWebEvents(env.DB, id),
    ]);
    return { success: true, data: { id, conversation, web_events: webEvents } };
  },

  async preview(
    { env, user }: PlanCall,
    scope: readonly string[] | null,
  ): Promise<BalanceQueryPreviewResponse> {
    const [plan, runners] = await Promise.all([
      loadBalanceQueryPlan(env.DB, { scope }),
      loadBalanceRunnerStatus(env.DB, subjectOf(user)),
    ]);
    return {
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
    };
  },

  async preflight(
    { env, user }: PlanCall,
    query: v.InferOutput<typeof BalanceQueryPreflightQuery>,
  ): Promise<BalanceQueryPreflightResponse> {
    const requestedBySubject = subjectOf(user);
    const phoneIccid = query.phone_iccid?.trim();
    if (!phoneIccid) throw new ORPCError('BAD_REQUEST', { message: PHONE_ICCID_REQUIRED });

    const [items, runners] = await Promise.all([
      loadBalanceQueryPlan(env.DB, { scope: [phoneIccid], allowDiscovery: true }),
      loadBalanceRunnerStatus(env.DB, requestedBySubject),
    ]);
    const item = items[0];
    if (!item) throw new ORPCError('NOT_FOUND', { message: 'SIM not found' });

    const method = describeBalanceMethod(item.profile);
    return {
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
    };
  },

  async query(
    { env, user }: QueueCall,
    body: v.InferOutput<typeof BalanceQueryBody>,
  ): Promise<BalanceQueryResponse> {
    const requestedBySubject = subjectOf(user);
    const [item] = await loadBalanceQueryPlan(env.DB, {
      scope: [body.phone_iccid],
      allowDiscovery: true,
    });
    if (!item) throw new ORPCError('NOT_FOUND', { message: 'SIM not found' });
    if (!item.eligible) {
      throw new ORPCError(item.reason === 'cooldown' ? 'TOO_MANY_REQUESTS' : 'CONFLICT', {
        message: INELIGIBLE_ERRORS[item.reason],
        data: {
          reason: item.reason,
          previous_check: item.recentCheck,
        } satisfies BalanceQueryRefusal,
      });
    }

    const queued = await queueBalanceCheck(env.DB, item, requestedBySubject);
    const [check] = await loadQueuedChecks(env.DB, [queued.id]);
    if (check === undefined) throw new Error(`Queued balance check ${queued.id} is missing`);
    return { success: true, check };
  },

  async queryBatch(
    { env, user }: QueueCall,
    body: v.InferOutput<typeof BalanceQueryBatchBody>,
  ): Promise<BalanceQueryBatchResponse> {
    const requestedBySubject = subjectOf(user);
    const { methods, phone_iccids: scope } = body;

    const plan = await loadBalanceQueryPlan(env.DB, { scope });
    const eligible = filterBalancePlanByMethods(plan, methods);
    const queuedIds: string[] = [];
    const failures: { phone_iccid: string; sim_index: number; error: string }[] = [];

    // One audited transaction per SIM. Daemon fetch ranks messages per purpose, so a
    // fleet action cannot monopolise normal user SMS delivery.
    for (const item of eligible) {
      try {
        queuedIds.push((await queueBalanceCheck(env.DB, item, requestedBySubject)).id);
      } catch (error) {
        failures.push({
          phone_iccid: item.phone.iccid,
          sim_index: item.phone.sim_index,
          error: errorText(error),
        });
      }
    }

    const checks = await loadQueuedChecks(env.DB, queuedIds);

    return {
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
    };
  },

  async create(
    { env }: OpsCall,
    { phone_iccid, profile_id }: v.InferOutput<typeof BalanceCheckCreateBody>,
  ): Promise<BalanceCheckCreateResponse> {
    const db = env.DB;
    const [profile, phone, recent] = await Promise.all([
      findEnabledBalanceProfile(db, profile_id),
      findCheckPhone(db, phone_iccid),
      findRecentBalanceCheck(db, phone_iccid),
    ]);

    if (!profile) throw refused('NOT_FOUND', 'Balance profile is not enabled');
    if (profile.method !== 'sms' && profile.method !== 'browser') {
      throw refused('BAD_REQUEST', 'Profile method is not implemented');
    }
    if (phone?.sim_status !== 'active') throw refused('CONFLICT', 'SIM is not active');
    if (
      phone.country !== profile.country_code ||
      !carrierMatchesProfile(phone.carrier, profile.carrier)
    ) {
      throw refused('CONFLICT', 'SIM does not match the carrier profile');
    }
    if (recent) {
      throw new ORPCError('TOO_MANY_REQUESTS', {
        data: {
          wire: {
            success: false,
            error: 'This SIM has already been queried in the last 24 hours',
            previous_check: recent,
          },
        },
      });
    }

    const check = await queueBalanceCheck(
      db,
      { phone, profile: { ...profile, method: profile.method } },
      null,
    );
    return { success: true, check };
  },

  async continue(
    { env }: OpsCall,
    { check_id }: v.InferOutput<typeof BalanceCheckIdBody>,
  ): Promise<BalanceCheckStepResponse> {
    const check = await findBalanceCheckToContinue(env.DB, check_id);

    if (!check) throw refused('NOT_FOUND', 'Balance check not found');
    if (
      (check.status !== 'response_received' && check.status !== 'unparsed') ||
      check.response_message_id === null ||
      check.raw_response === null
    ) {
      throw refused('CONFLICT', 'Balance check cannot be continued');
    }

    const step = matchingNextStep(check, check.raw_response);
    if (!step) throw refused('CONFLICT', 'No allowlisted next step matches the reply');

    const result = await queueBalanceFollowUp(
      env.DB,
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
      throw refused('CONFLICT', 'Balance check changed before it was continued');
    }

    return {
      success: true,
      check: {
        id: check.id,
        status: 'queued',
        step_index: check.step_index + 1,
        outbound_message_id: result.message_id,
      },
    };
  },

  async retry(
    { env }: OpsCall,
    { check_id }: v.InferOutput<typeof BalanceCheckIdBody>,
  ): Promise<BalanceCheckStepResponse> {
    const check = await findBalanceCheckToRetry(env.DB, check_id);

    const step = check ? attemptedStep(check) : null;
    if (
      check?.status !== 'failed' ||
      check.message_status !== 'failed' ||
      check.message_content !== step?.command ||
      check.message_recipient !== check.destination
    ) {
      throw refused('CONFLICT', 'No allowlisted failed step can be retried');
    }

    if (!(await requeueBalanceCheck(env.DB, check))) {
      throw refused('CONFLICT', 'Balance check changed before retry');
    }

    return {
      success: true,
      check: {
        id: check.id,
        status: 'queued',
        step_index: check.step_index,
        outbound_message_id: check.message_id,
      },
    };
  },

  async stop(
    { env }: OpsCall,
    { check_id }: v.InferOutput<typeof BalanceCheckIdBody>,
  ): Promise<BalanceCheckStopResponse> {
    const check = await findBalanceCheckToStop(env.DB, check_id);
    if (!check) throw refused('NOT_FOUND', 'Balance check not found');
    if (check.status !== 'awaiting_response' && check.status !== 'response_received') {
      throw refused('CONFLICT', 'Balance check is not stoppable');
    }

    const finalStatus = check.status === 'awaiting_response' ? 'timed_out' : 'unparsed';
    if (!(await stopBalanceCheck(env.DB, check, finalStatus)))
      throw refused('CONFLICT', 'Balance check changed before stop');

    return { success: true, check: { id: check.id, status: finalStatus } };
  },
};
