import * as v from 'valibot';
import { BalanceSkillJob } from '../../shared/api/balance-skill-jobs.js';
import { readJson } from '../../shared/parse-json.js';
import { textOr } from '../../shared/text.js';
import {
  buildBalanceSkillPrompt,
  buildExplicitBalanceFollowUp,
  validateBalanceSkillDecision,
} from '../../server/utils/balance-skill.js';
import type { CompanyAIProtocol } from '../../server/utils/company-ai.js';
import type { ControlClient } from '../control-client.js';
import { errorMessage } from '../error-message.js';
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

function responseError(prefix: string, response: Response, detail: string): Error {
  return new Error(`${prefix} (${response.status}): ${detail.slice(0, 500)}`);
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
      await controlClient.request(
        `/api/control/balance-skills/jobs/${encodeURIComponent(job.id)}/release`,
        {
          method: 'POST',
          body: JSON.stringify({
            runner_id: runnerId,
            error: errorMessage(error),
          }),
        },
      );
    } catch (releaseError) {
      logger.error(`Could not release job ${job.id}: ${errorMessage(releaseError)}`);
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
        probeError = errorMessage(error);
      });
      if (!reachable) {
        await presence.set('degraded', null, 'vpn_or_ai_unreachable');
        logger.log(
          `Company AI is unreachable (${textOr(probeError, 'no response')}); waiting for VPN connectivity.`,
        );
        return { handled: false, retryDelay: 15_000 };
      }

      const claimPath = `/api/control/balance-skills/jobs/claim?runner_id=${encodeURIComponent(runnerId)}`;
      const response = await controlClient.request(claimPath, { signal });
      if (response.status === 204) return { handled: false, retryDelay: 5_000 };
      if (!response.ok) {
        throw responseError('Could not claim a skill job', response, await response.text());
      }

      const claimed = await readJson(response, BalanceSkillJob);
      if (!claimed.ok) throw new Error(`Could not read the claimed skill job: ${claimed.error}`);
      const job = claimed.value;
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
        const submitted = await controlClient.request(
          `/api/control/balance-skills/jobs/${encodeURIComponent(job.id)}/decision`,
          {
            method: 'POST',
            body: JSON.stringify({ runner_id: runnerId, model: aiModel, decision }),
            signal,
          },
        );
        if (!submitted.ok) {
          throw responseError('Worker rejected the decision', submitted, await submitted.text());
        }
        logger.log(`Applied ${decision.action} decision for balance check ${job.check_id}.`);
        await presence.set('ready');
        return { handled: true, retryDelay: 0 };
      } catch (error) {
        await release(job, error);
        logger.error(`Balance skill job ${job.id} failed: ${errorMessage(error)}`);
        await presence.set('ready');
        return { handled: true, retryDelay: 30_000 };
      }
    },
  });
}
