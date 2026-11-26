import * as v from 'valibot';
import type { BalanceSkillJob } from '../../../../shared/api/balance-skill-jobs.js';
import { textOr } from '../../../../shared/text.js';
import {
  buildBalanceSkillPrompt,
  buildExplicitBalanceFollowUp,
  validateBalanceSkillDecision,
} from '../../../../shared/balance-skill.js';
import type { CompanyAIProtocol } from '../company-ai.js';
import { ControlError, type ControlClient } from '../control-client.js';
import { errorText } from '../../../../shared/error-text.js';
import { pollDelayMs } from '../pace.js';
import type { CapabilityPresence } from '../presence.js';
import type { RunOutcome } from '../serial-runner.js';

const AiCheckAnswer = v.looseObject({ status: v.literal('ok') });

interface CompanyAICall {
  baseUrl: string;
  token: string;
  model: string;
  protocol: CompanyAIProtocol;
  prompt: { system: string; user: string };
}

interface Logger {
  log(message: string): void;
  error(message: string): void;
}

function rejected(prefix: string, error: unknown): unknown {
  if (!(error instanceof ControlError)) return error;
  return new Error(`${prefix} (${String(error.status)}): ${error.body.slice(0, 500)}`, {
    cause: error,
  });
}

export function createSmsAiCapability({
  controlClient,
  presence,
  runnerId,
  aiBaseUrl,
  aiToken,
  aiModel,
  aiProtocol = 'anthropic',
  callAI,
  isAIReachable,
  logger = console,
}: {
  controlClient: ControlClient;
  presence: CapabilityPresence;
  runnerId: string;
  aiBaseUrl: string;
  aiToken: string;
  aiModel: string;
  aiProtocol?: CompanyAIProtocol;
  callAI: (call: CompanyAICall) => Promise<unknown>;
  isAIReachable: (
    baseUrl: string,
    fetchImpl?: undefined,
    onError?: (error: unknown) => void,
  ) => Promise<boolean>;
  logger?: Logger;
}) {
  let probeError: string | null = null;

  async function release(job: BalanceSkillJob, error: unknown): Promise<void> {
    try {
      await controlClient.balanceSkillJobs.release({
        params: { id: job.id },
        body: { runner_id: runnerId, error: errorText(error) },
      });
    } catch (releaseError) {
      logger.error(`Could not release job ${job.id}: ${errorText(releaseError)}`);
    }
  }

  return Object.freeze({
    async checkConfiguration(): Promise<void> {
      if (!(await isAIReachable(aiBaseUrl))) {
        throw new Error('Company AI is unreachable; connect to the VPN and retry');
      }
      const result = await callAI({
        baseUrl: aiBaseUrl,
        token: aiToken,
        model: aiModel,
        protocol: aiProtocol,
        prompt: {
          system: 'Return one JSON object and no prose.',
          user: 'Return exactly {"status":"ok"}.',
        },
      });
      if (!v.is(AiCheckAnswer, result)) {
        throw new Error('Company AI check returned unexpected JSON');
      }
    },

    async runOne({ signal }: { signal?: AbortSignal | null } = {}): Promise<RunOutcome> {
      const reachable = await isAIReachable(aiBaseUrl, undefined, (error) => {
        probeError = errorText(error);
      });
      if (!reachable) {
        await presence.set('degraded', null, 'vpn_or_ai_unreachable');
        logger.log(
          `Company AI is unreachable (${textOr(probeError, 'no response')}); waiting for VPN connectivity.`,
        );
        return { handled: false, retryDelay: 15_000 };
      }

      const claim = await controlClient.balanceSkillJobs
        .claim({ query: { runner_id: runnerId } }, signal ? { signal } : {})
        .catch((error: unknown) => {
          throw rejected('Could not claim a skill job', error);
        });
      if (claim.status === 204) return { handled: false, retryDelay: pollDelayMs(claim.headers) };
      const job: BalanceSkillJob = claim.body;
      await presence.set('busy', job.id);
      try {
        const proposed =
          buildExplicitBalanceFollowUp(job.response_content, job.skill) ??
          (await callAI({
            baseUrl: aiBaseUrl,
            token: aiToken,
            model: aiModel,
            prompt: buildBalanceSkillPrompt(job),
            protocol: aiProtocol,
          }));
        const decision = validateBalanceSkillDecision({
          decision: proposed,
          content: job.response_content,
          skill: job.skill,
        });
        await controlClient.balanceSkillJobs
          .decision(
            {
              params: { id: job.id },
              body: { runner_id: runnerId, model: aiModel, decision },
            },
            signal ? { signal } : {},
          )
          .catch((error: unknown) => {
            throw rejected('Worker rejected the decision', error);
          });
        logger.log(`Applied ${decision.action} decision for balance check ${job.check_id}.`);
        await presence.set('ready');
        return { handled: true, retryDelay: 0 };
      } catch (error) {
        await release(job, error);
        logger.error(`Balance skill job ${job.id} failed: ${errorText(error)}`);
        await presence.set('ready');
        return { handled: true, retryDelay: 30_000 };
      }
    },
  });
}
