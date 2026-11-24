import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import type { D1, D1Batch } from '../lib/d1.js';
import { textOr } from '../../shared/text.js';
import {
  claimSkillJob,
  completeSkillJobAfterReplyStatement,
  loadSkillJob,
  recordParsedSkillBalance,
  releaseSkillJob,
  skillDecisionStatement,
  stopLeasedSkillJob,
  stopSkillJobWithDecision,
  type SkillJob,
} from '../db/balance-skill-jobs.js';
import type {
  BalanceSkillJob,
  SkillDecisionBody,
  SkillDecisionResponse,
  SkillReleaseBody,
} from '../../shared/api/balance-skill-jobs.js';
import {
  extractBalanceMenuOptions,
  parseBalanceSkillConfig,
  validateBalanceSkillDecision,
  type BalanceDecision,
} from '../../shared/balance-skill.js';
import { errorText } from '../../shared/error-text.js';
import { runnerCanAccessOwner, type AuthorizedRunner } from '../utils/runner-auth.js';
import { queueBalanceFollowUp } from './balance-replies.js';

const LEASE_SECONDS = 120;

const LEASE_NOT_ACTIVE = 'Skill job lease is not active for this runner';
const DECISION_RACED = 'Balance check changed before the decision was applied';

/** A job route as the contract hands it over, once the runner has been admitted. */
interface JobCall {
  env: { DB: D1<'first' | 'run'> & D1Batch<'run'> };
}

/** A refusal the Agent reads as { error }. */
function refused(
  code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
  message: string,
): ORPCError<string, undefined> {
  return new ORPCError(code, { message });
}

function leaseIsActive(job: SkillJob, runnerId: string): boolean {
  return (
    job.status === 'leased' &&
    job.lease_owner === runnerId &&
    job.lease_expires_at !== null &&
    new Date(`${job.lease_expires_at}Z`) > new Date()
  );
}

export const balanceSkillRunnerHandler = {
  /** The oldest job this runner's account may take, leased to it; null when none waits. */
  async claim(
    { env }: JobCall,
    auth: AuthorizedRunner,
    runnerId: string,
  ): Promise<BalanceSkillJob | null> {
    const leased = await claimSkillJob(env.DB, runnerId, LEASE_SECONDS, auth);

    if (!leased) return null;
    const job = await loadSkillJob(env.DB, leased.id);
    const skill = job ? parseBalanceSkillConfig(job.skill_config) : null;
    if (!job || !skill || job.step_index >= skill.max_turns) {
      await stopLeasedSkillJob(
        env.DB,
        leased.id,
        runnerId,
        'Skill configuration is invalid or maximum turns reached',
      );
      return null;
    }

    return {
      id: job.id,
      check_id: job.check_id,
      step_index: job.step_index,
      attempts: job.attempts,
      skill,
      menu_options: extractBalanceMenuOptions(job.response_content),
      response_content: job.response_content,
    };
  },

  async decide(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    { runner_id: runnerId, decision: proposed, model }: v.InferOutput<typeof SkillDecisionBody>,
  ): Promise<SkillDecisionResponse> {
    const db = env.DB;
    const job = await loadSkillJob(db, id);
    if (!job) throw refused('NOT_FOUND', 'Skill job not found');
    if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
      throw refused('FORBIDDEN', 'Skill job belongs to another account');
    }
    if (!leaseIsActive(job, runnerId)) throw refused('CONFLICT', LEASE_NOT_ACTIVE);
    if (job.check_status !== 'response_received' && job.check_status !== 'unparsed') {
      throw refused('CONFLICT', 'Balance check is no longer awaiting a skill decision');
    }

    const skill = parseBalanceSkillConfig(job.skill_config);
    if (!skill) throw refused('CONFLICT', 'Balance skill configuration is invalid');

    let decision: BalanceDecision;
    try {
      decision = validateBalanceSkillDecision({
        decision: proposed,
        content: job.response_content,
        skill,
      });
    } catch (error) {
      throw refused('BAD_REQUEST', errorText(error));
    }

    const audit = skillDecisionStatement(db, job, skill, model, decision);
    switch (decision.action) {
      case 'reply': {
        const finishJob = completeSkillJobAfterReplyStatement(db, job, runnerId);
        const result = await queueBalanceFollowUp(
          db,
          {
            id: job.check_id,
            sim_number: job.sim_number,
            destination: job.destination,
            step_index: job.step_index,
          },
          {
            id: job.response_message_id,
            phone_number: job.response_sender,
            content: job.response_content,
          },
          { command: decision.selected_option ?? '' },
          job.check_status,
          [audit, finishJob],
        );
        if (!result.queued) throw refused('CONFLICT', DECISION_RACED);
        return { status: 202, body: { success: true, action: 'reply', status: 'queued' } };
      }

      case 'complete': {
        const changes = await recordParsedSkillBalance(db, job, runnerId, decision, audit);
        if (changes === 0) throw refused('CONFLICT', DECISION_RACED);
        return { status: 200, body: { success: true, action: 'complete', status: 'parsed' } };
      }

      case 'stop': {
        await stopSkillJobWithDecision(db, job, runnerId, audit);
        return { status: 200, body: { success: true, action: 'stop', reason: decision.reason } };
      }
    }
  },

  async release(
    { env }: JobCall,
    auth: AuthorizedRunner,
    id: string,
    { runner_id: runnerId, error }: v.InferOutput<typeof SkillReleaseBody>,
  ): Promise<{ success: true }> {
    const job = await loadSkillJob(env.DB, id);
    if (!job) throw refused('NOT_FOUND', 'Skill job not found');
    if (!runnerCanAccessOwner(auth, job.requested_by_subject)) {
      throw refused('FORBIDDEN', 'Skill job belongs to another account');
    }
    const changes = await releaseSkillJob(
      env.DB,
      id,
      runnerId,
      textOr(error, 'Runner released the job').slice(0, 1000),
    );
    if (changes === 0) throw refused('CONFLICT', LEASE_NOT_ACTIVE);
    return { success: true };
  },
};
