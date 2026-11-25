import { ORPCError } from '@orpc/server';
import { nanoid } from 'nanoid';
import * as v from 'valibot';
import { D1_MAX_BOUND_PARAMETERS, type D1, type D1Batch } from '../lib/d1.js';
import {
  findBalanceCheckId,
  findBalanceCheckToContinue,
  findBalanceCheckToRetry,
  findBalanceCheckToStop,
  listBalanceCheckMessages,
  listBalanceChecks,
  listBalanceChecksByIds,
  listBalanceCheckStatuses,
  listBalanceCheckWebEvents,
  queueSmsBalanceCheck,
  requeueBalanceCheck,
  runBalanceStatements,
  stopBalanceCheck,
} from '../db/balance-checks.js';
import {
  findCheckPhone,
  findEnabledBalanceProfile,
  findRecentBalanceCheck,
  listCooldownChecks,
  listParsedChecks,
  listPlanPhones,
  listQueryProfiles,
  type BalanceProfile,
  type PlanPhone,
} from '../db/balance-plan.js';
import {
  INELIGIBLE_REASONS,
  type BalanceQueryBatchResponse,
  type BalanceQueryPreflightResponse,
  type BalanceQueryPreviewResponse,
  type BalanceQueryResponse,
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
import {
  buildBalanceQueryPlan,
  carrierMatchesProfile,
  describeBalanceMethod,
  filterBalancePlanByMethods,
  queryMethod,
  summarizeMethods,
  summarizePlan,
  type EligiblePlanItem,
  type PlanItem,
} from '../utils/balance-plan.js';
import { displayBalanceStatus, toBalanceChecks } from '../utils/balance-display.js';
import { attemptedStep, matchingNextStep } from '../utils/balance-reply-parse.js';
import { loadBalanceRunnerStatus } from './balance-runners.js';
import { queueBalanceFollowUp } from './balance-replies.js';
import {
  createCarrierWebBalanceStatements,
  newCarrierWebBalanceIds,
} from './carrier-web-balance.js';

type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

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

async function loadBalanceQueryPlan(
  db: D1<'all'>,
  { scope, allowDiscovery = false }: { scope: readonly string[]; allowDiscovery?: boolean },
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
    scope: readonly string[],
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
