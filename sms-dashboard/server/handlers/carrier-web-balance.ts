import { ORPCError } from '@orpc/server';
import { nanoid } from 'nanoid';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import type { D1, D1Batch, D1Operation, D1Statement } from '../lib/d1.js';
import {
  WEB_PROVIDERS,
  claimWebJob,
  completeWebJob,
  failExpiredWebJobs,
  failLeasedWebJob,
  failWebJob,
  listOtpCandidates,
  loadWebJob,
  markWebJobAwaitingOtp,
  queueWebBalanceStatements,
  reconcileTerminalWebJobs,
  recordWebEvent,
  recordWebHeartbeat,
  recordWebOtpMatch,
  releaseWebJob,
  type WebJob,
  type WebProvider,
} from '../db/carrier-web-balance.js';
import { textOr } from '../../shared/text.js';
import {
  WebJobCompleteFields,
  WebJobErrorFields,
  WebJobHeartbeatFields,
  type CarrierWebBalanceJobWire,
  type CarrierWebBalanceOtpWire,
  type WebJobActionResponse,
  type WebJobCompleteBody,
  type WebJobErrorBody,
  type WebJobHeartbeatBody,
  type WebJobHeartbeatResponse,
  type WebJobLeaseBody,
  type WebJobOtpQuery,
} from '../../shared/api/carrier-web-balance.js';
import { runnerCanAccessOwner, type AuthorizedRunner } from '../utils/runner-auth.js';
import { senderMatches } from '../utils/spam-filter.js';
import { ACTIVE_WEB_JOB_STATUSES } from '../../shared/balance-status.js';

interface ProviderConfig {
  skillId: string;
  currency: string;
  otpContext: RegExp;
  rawResponse: string;
  expiryRequired: boolean;
}

const NORMAL_LEASE_SECONDS = 120;
const HUMAN_LEASE_SECONDS = 900;
const PROVIDERS: Readonly<Record<WebProvider, ProviderConfig>> = {
  china_unicom: {
    skillId: 'unicom-web-balance',
    currency: 'CNY',
    otpContext: /(?:随机密码|隨機密碼|验证码|驗證碼|登录|登錄|登入)/,
    rawResponse: 'Official China Unicom web balance query',
    expiryRequired: false,
  },
  m1_prepaid: {
    skillId: 'm1-prepaid-web-balance',
    currency: 'SGD',
    otpContext: /\botp\s+for\s+login\b/i,
    rawResponse: 'Official M1 prepaid portal balance query',
    expiryRequired: true,
  },
};

const ActiveStatusSchema = v.picklist(ACTIVE_WEB_JOB_STATUSES);

const SkillConfig = v.looseObject({ id: v.string() });

const IsoDate = v.pipe(v.string(), v.check(validIsoDate));

/** A job route as the contract hands it over, once the runner has been admitted. */
interface JobCall<Op extends D1Operation = 'first'> {
  env: { DB: D1<Op | 'run'> & D1Batch<'run'> };
}

/** A refusal the Agent reads as { error }. */
function refused(
  code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
  message: string,
): ORPCError<string, undefined> {
  return new ORPCError(code, { message });
}

/** The rest of an action's body, read once the lease holds. */
function fieldsOf<S extends v.GenericSchema>(schema: S, body: unknown): v.InferOutput<S> {
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) throw refused('BAD_REQUEST', parsed.issues[0].message);
  return parsed.output;
}

function normalizePhone(value: string, provider: WebProvider): string {
  const digits = value.replace(/\D/g, '');
  switch (provider) {
    case 'china_unicom':
      return digits.replace(/^86(?=1\d{10}$)/, '');
    case 'm1_prepaid':
      return digits.replace(/^65(?=\d{8}$)/, '');
  }
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function expectedSenderMatches(rawSender: string | null, expectedSendersJson: string): boolean {
  const expected = parseJson(expectedSendersJson, v.array(v.unknown()));
  return expected.ok && expected.value.some((sender) => senderMatches(rawSender, sender));
}

function leaseIsActive(job: WebJob, runnerId: string): boolean {
  if (
    !v.is(ActiveStatusSchema, job.status) ||
    job.lease_owner !== runnerId ||
    job.lease_expires_at === null
  ) {
    return false;
  }
  return new Date(`${job.lease_expires_at}Z`) > new Date();
}

export async function reconcileTerminalWebBalanceJobs(db: D1<'run'> & D1Batch<'run'>) {
  return { reconciled: await reconcileTerminalWebJobs(db) };
}

export async function maintainWebBalanceJobs(db: D1<'run'> & D1Batch<'run'>) {
  const expired = await failExpiredWebJobs(
    db,
    'Browser runner lease expired after login flow started',
  );
  const terminal = await reconcileTerminalWebBalanceJobs(db);
  return {
    expired,
    reconciled: terminal.reconciled,
  };
}

/** The job `id`, when `runnerId` holds its lease for the admitted runner's account. */
async function requireLease(
  db: D1<'first'>,
  auth: AuthorizedRunner,
  id: string,
  runnerId: string,
): Promise<WebJob> {
  const job = await loadWebJob(db, id);
  if (job === null) throw refused('NOT_FOUND', 'Web balance job not found');
  if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
    throw refused('FORBIDDEN', 'Web balance job belongs to another account');
  }
  if (!leaseIsActive(job, runnerId)) {
    throw refused('CONFLICT', 'Web balance job lease is not active for this runner');
  }
  if (job.check_status !== 'queued') throw refused('CONFLICT', 'Balance check is no longer queued');
  return job;
}

export const carrierWebBalanceHandler = {
  /** The oldest job this runner's account may take, leased to it; null when none waits. */
  async claim(
    { env }: JobCall,
    auth: AuthorizedRunner,
    runnerId: string,
  ): Promise<CarrierWebBalanceJobWire | null> {
    const leased = await claimWebJob(env.DB, runnerId, NORMAL_LEASE_SECONDS, auth);

    if (leased === null) return null;
    const job = await loadWebJob(env.DB, leased.id);
    if (job === null) throw new Error(`Leased web balance job ${leased.id} could not be loaded`);
    const skill = parseJson(job.skill_config, SkillConfig);
    if (!skill.ok || skill.value.id !== PROVIDERS[job.provider].skillId) {
      await failLeasedWebJob(env.DB, job.id, job.check_id, runnerId);
      return null;
    }

    await recordWebEvent(env.DB, job.id, 'claimed', {
      attempts: job.attempts,
    });
    return {
      id: job.id,
      check_id: job.check_id,
      sim_iccid: job.sim_iccid,
      sim_number: job.sim_number,
      sim_index: job.sim_index,
      login_url: job.login_url,
      otp_requested_at: job.otp_requested_at,
      skill: skill.value,
    };
  },

  async otpRequested(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    { runner_id: runnerId }: v.InferOutput<typeof WebJobLeaseBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, runnerId);
    if (job.otp_requested_at !== null) {
      throw refused('CONFLICT', 'OTP was already requested for this job');
    }

    await markWebJobAwaitingOtp(env.DB, job.id, runnerId, NORMAL_LEASE_SECONDS);
    return { success: true, status: 'awaiting_otp' };
  },

  /** The code the carrier sent since the OTP was requested; null when none has arrived. */
  async otp(
    { env }: JobCall<'first' | 'all'>,
    auth: AuthorizedRunner,
    id: string,
    {
      runner_id: runnerId,
      after_created_at: afterCreatedAt,
      after_source_message_id: afterSourceMessageId,
    }: v.InferOutput<typeof WebJobOtpQuery>,
  ): Promise<CarrierWebBalanceOtpWire | null> {
    const job = await requireLease(env.DB, auth, id, runnerId);
    if (job.otp_requested_at === null) throw refused('CONFLICT', 'OTP has not been requested');

    const hasCursor =
      afterCreatedAt !== '' &&
      afterSourceMessageId !== '' &&
      afterCreatedAt.length <= 40 &&
      afterSourceMessageId.length <= 200;
    const candidates = await listOtpCandidates(
      env.DB,
      job.sim_iccid,
      job.otp_requested_at,
      hasCursor ? { createdAt: afterCreatedAt, messageId: afterSourceMessageId } : null,
    );
    const provider = PROVIDERS[job.provider];
    const message = candidates.find(
      (candidate) =>
        expectedSenderMatches(candidate.phone_number, job.expected_senders) &&
        provider.otpContext.test(candidate.content),
    );
    if (message === undefined) {
      const last = candidates.at(-1);
      if (last === undefined) return null;
      return {
        code: null,
        cursor: {
          created_at: last.created_at,
          source_message_id: last.id,
        },
      };
    }

    await recordWebOtpMatch(env.DB, job.id, runnerId, message.id, NORMAL_LEASE_SECONDS);
    return { code: message.verification_code };
  },

  async heartbeat(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobHeartbeatBody>,
  ): Promise<WebJobHeartbeatResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const { status, reason: reported } = fieldsOf(WebJobHeartbeatFields, body);

    const human = status === 'human_verification_required';
    const leaseSeconds = human ? HUMAN_LEASE_SECONDS : NORMAL_LEASE_SECONDS;
    const reason = human
      ? textOr(reported, 'Official site requested human verification').slice(0, 500)
      : null;
    const changed = job.status !== status || job.human_reason !== reason;
    await recordWebHeartbeat(
      env.DB,
      job.id,
      runnerId,
      status,
      reason,
      leaseSeconds,
      changed ? { status, ...(reason === null || reason === '' ? {} : { reason }) } : null,
    );
    return { success: true, status, lease_seconds: leaseSeconds };
  },

  async complete(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobCompleteBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const {
      balance,
      currency,
      account_number: accountNumber,
      expires_at: reportedExpiry,
    } = fieldsOf(WebJobCompleteFields, body);
    const provider = PROVIDERS[job.provider];
    if (currency !== provider.currency) {
      throw refused('BAD_REQUEST', `currency must be ${provider.currency}`);
    }
    const account = normalizePhone(accountNumber ?? '', job.provider);
    if (account === '' || account !== normalizePhone(job.sim_number ?? '', job.provider)) {
      throw refused('CONFLICT', 'Authenticated account does not match the balance task SIM');
    }

    let expiresAt: string | null = null;
    if (provider.expiryRequired) {
      const expiry = v.safeParse(IsoDate, reportedExpiry);
      if (!expiry.success) {
        throw refused('BAD_REQUEST', 'expires_at must be a real ISO calendar date');
      }
      expiresAt = expiry.output;
    }

    const checkChanges = await completeWebJob(env.DB, job, runnerId, {
      balance,
      currency: provider.currency,
      rawResponse: provider.rawResponse,
      expiresAt,
      expiryRequired: provider.expiryRequired,
      event: {
        currency: provider.currency,
        parser_version: job.profile_parser_version,
        ...(expiresAt === null || expiresAt === '' ? {} : { expires_at: expiresAt }),
      },
    });
    if (checkChanges === 0) {
      throw refused('CONFLICT', 'Balance check changed before completion');
    }
    return { success: true, status: 'parsed' };
  },

  async fail(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobErrorBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const error = textOr(fieldsOf(WebJobErrorFields, body).error, 'Web balance query failed').slice(
      0,
      1000,
    );
    await failWebJob(env.DB, job, runnerId, error);
    return { success: true, status: 'failed' };
  },

  async release(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    body: v.InferOutput<typeof WebJobErrorBody>,
  ): Promise<WebJobActionResponse> {
    const job = await requireLease(env.DB, auth, id, body.runner_id);
    const runnerId = body.runner_id;
    const error = textOr(fieldsOf(WebJobErrorFields, body).error, 'Runner released the job').slice(
      0,
      1000,
    );
    const terminal = job.otp_requested_at !== null;
    await releaseWebJob(env.DB, job, runnerId, error, terminal);
    return { success: true, status: terminal ? 'failed' : 'pending' };
  },
};

function providerForProfile(profile: { skill_config?: string | null }): WebProvider {
  const skill = parseJson(textOr(profile.skill_config, '{}'), SkillConfig);
  const provider = skill.ok
    ? WEB_PROVIDERS.find((candidate) => PROVIDERS[candidate].skillId === skill.value.id)
    : undefined;
  if (provider === undefined) throw new Error('Unsupported browser balance profile');
  return provider;
}

export function createCarrierWebBalanceStatements(
  db: D1<'run'>,
  {
    checkId,
    jobId,
    phone,
    profile,
    requestedBySubject = null,
  }: {
    checkId: string;
    jobId: string;
    phone: { iccid: string };
    profile: { id: string; parser_version: string; skill_config?: string | null };
    requestedBySubject?: string | null;
  },
): D1Statement<'run'>[] {
  return queueWebBalanceStatements(db, {
    checkId,
    jobId,
    iccid: phone.iccid,
    profile,
    provider: providerForProfile(profile),
    requestedBySubject,
  });
}

export function newCarrierWebBalanceIds() {
  return {
    checkId: `bal-${nanoid()}`,
    jobId: `webbal-${nanoid()}`,
  };
}
