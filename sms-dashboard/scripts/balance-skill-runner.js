import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildBalanceSkillPrompt, validateBalanceSkillDecision } from '../server/utils/balance-skill.js';
import { callCompanyAI, companyAIReachable } from '../server/utils/company-ai.js';

const apiUrl = (process.env.SMS_API_URL || 'https://sexy.qzz.io').replace(/\/+$/, '');
const aiBaseUrl = (process.env.BALANCE_AI_BASE_URL
  || 'https://aihub.huobiapps.com/api/cc').replace(/\/+$/, '');
const apiKey = process.env.API_KEY;
const aiToken = process.env.BALANCE_AI_TOKEN;
const aiModel = process.env.BALANCE_AI_MODEL;
const aiProtocol = process.env.BALANCE_AI_PROTOCOL || 'anthropic';
const runnerId = process.env.BALANCE_SKILL_RUNNER_ID
  || `${hostname()}-${randomUUID().slice(0, 8)}`;
const once = process.argv.includes('--once');
const checkOnly = process.argv.includes('--check');

function requireConfiguration() {
  const missing = [
    ['API_KEY', apiKey],
    ['BALANCE_AI_TOKEN', aiToken],
    ['BALANCE_AI_MODEL', aiModel],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function workerRequest(path, options = {}) {
  return fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      'X-API-Key': apiKey,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function release(job, error) {
  try {
    await workerRequest(`/api/control/balance-skills/jobs/${encodeURIComponent(job.id)}/release`, {
      method: 'POST',
      body: JSON.stringify({ runner_id: runnerId, error: error.message || String(error) }),
    });
  } catch (releaseError) {
    console.error(`Could not release job ${job.id}: ${releaseError.message}`);
  }
}

async function runOne() {
  if (!await companyAIReachable(aiBaseUrl)) {
    console.log('Company AI is unreachable; waiting for VPN connectivity.');
    return { handled: false, retryDelay: 15_000 };
  }

  const claimUrl = `/api/control/balance-skills/jobs/claim?runner_id=${encodeURIComponent(runnerId)}`;
  const response = await workerRequest(claimUrl);
  if (response.status === 204) return { handled: false, retryDelay: 5_000 };
  if (!response.ok) {
    throw new Error(`Could not claim a skill job (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  const job = await response.json();
  try {
    const proposed = await callCompanyAI({
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
    const submitted = await workerRequest(
      `/api/control/balance-skills/jobs/${encodeURIComponent(job.id)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({ runner_id: runnerId, model: aiModel, decision }),
      },
    );
    if (!submitted.ok) {
      throw new Error(`Worker rejected the decision (${submitted.status}): ${(await submitted.text()).slice(0, 500)}`);
    }
    console.log(`Applied ${decision.action} decision for balance check ${job.check_id}.`);
    return { handled: true, retryDelay: 0 };
  } catch (error) {
    await release(job, error);
    console.error(`Balance skill job ${job.id} failed: ${error.message}`);
    return { handled: true, retryDelay: 30_000 };
  }
}

async function main() {
  requireConfiguration();
  if (checkOnly) {
    if (!await companyAIReachable(aiBaseUrl)) {
      throw new Error('Company AI is unreachable; connect to the VPN and retry');
    }
    const result = await callCompanyAI({
      baseUrl: aiBaseUrl,
      token: aiToken,
      model: aiModel,
      protocol: aiProtocol,
      prompt: {
        system: 'Return one JSON object and no prose.',
        user: 'Return exactly {"status":"ok"}.',
      },
    });
    if (result?.status !== 'ok') throw new Error('Company AI check returned unexpected JSON');
    console.log('Company AI connectivity, token, protocol, and model are valid.');
    return;
  }
  console.log(`Balance skill runner ${runnerId} started; AI token remains local.`);
  do {
    try {
      const result = await runOne();
      if (once) break;
      if (result.retryDelay) await sleep(result.retryDelay);
    } catch (error) {
      console.error(error.message);
      if (once) throw error;
      await sleep(15_000);
    }
  } while (true);
}

await main();
