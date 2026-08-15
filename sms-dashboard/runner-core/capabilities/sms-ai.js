import {
  buildBalanceSkillPrompt,
  buildExplicitBalanceFollowUp,
  validateBalanceSkillDecision,
} from '../../server/utils/balance-skill.js';

function responseError(prefix, response, detail) {
  return new Error(`${prefix} (${response.status}): ${String(detail || '').slice(0, 500)}`);
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
}) {
  async function release(job, error) {
    try {
      await controlClient.request(
        `/api/control/balance-skills/jobs/${encodeURIComponent(job.id)}/release`,
        {
          method: 'POST',
          body: JSON.stringify({
            runner_id: runnerId,
            error: error.message || String(error),
          }),
        },
      );
    } catch (releaseError) {
      logger.error(`Could not release job ${job.id}: ${releaseError.message}`);
    }
  }

  return Object.freeze({
    async checkConfiguration() {
      if (!await isAIReachable(aiBaseUrl)) {
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
      if (result?.status !== 'ok') {
        throw new Error('Company AI check returned unexpected JSON');
      }
    },

    async runOne({ signal } = {}) {
      if (!await isAIReachable(aiBaseUrl)) {
        await presence.set('degraded', null, 'vpn_or_ai_unreachable');
        logger.log('Company AI is unreachable; waiting for VPN connectivity.');
        return { handled: false, retryDelay: 15_000 };
      }

      await presence.set('ready');
      const claimPath = `/api/control/balance-skills/jobs/claim?runner_id=${encodeURIComponent(runnerId)}`;
      const response = await controlClient.request(claimPath, { signal });
      if (response.status === 204) return { handled: false, retryDelay: 5_000 };
      if (!response.ok) {
        throw responseError('Could not claim a skill job', response, await response.text());
      }

      const job = await response.json();
      await presence.set('busy', job.id);
      try {
        const proposed = buildExplicitBalanceFollowUp(job.response_content, job.skill)
          || await callAI({
            baseUrl: aiBaseUrl,
            token: aiToken,
            model: aiModel,
            prompt: buildBalanceSkillPrompt(job),
            protocol: aiProtocol,
          });
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
        logger.error(`Balance skill job ${job.id} failed: ${error.message}`);
        await presence.set('ready');
        return { handled: true, retryDelay: 30_000 };
      }
    },
  });
}
