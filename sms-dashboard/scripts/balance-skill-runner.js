import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { callCompanyAI, companyAIReachable } from '../server/utils/company-ai.js';
import { createControlClient } from '../runner-core/control-client.js';
import { createRunnerPresence } from '../runner-core/presence.js';
import { runSerialCapability } from '../runner-core/serial-runner.js';
import { createSmsAiCapability } from '../runner-core/capabilities/sms-ai.js';

const apiUrl = process.env.SMS_API_URL || 'https://sexy.qzz.io';
const aiBaseUrl = process.env.BALANCE_AI_BASE_URL || 'https://aihub.huobiapps.com/api/cc';
const apiKey = process.env.API_KEY;
const aiToken = process.env.BALANCE_AI_TOKEN;
const aiModel = process.env.BALANCE_AI_MODEL;
const aiProtocol = process.env.BALANCE_AI_PROTOCOL || 'anthropic';
const runnerId = process.env.BALANCE_SKILL_RUNNER_ID
  || `${hostname()}-${randomUUID().slice(0, 8)}`;
const agentId = process.env.BALANCE_AGENT_ID || `${hostname()}-legacy`;
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

async function main() {
  requireConfiguration();
  const controlClient = createControlClient({ baseUrl: apiUrl, apiKey });
  const presence = createRunnerPresence({
    controlClient,
    runnerId: agentId,
    sessionId: runnerId,
    displayName: hostname(),
    capability: 'sms_ai',
    version: process.env.BALANCE_AGENT_VERSION || 'development',
    platform: process.platform,
  });
  const capability = createSmsAiCapability({
    controlClient,
    presence,
    runnerId,
    aiBaseUrl,
    aiToken,
    aiModel,
    aiProtocol,
    callAI: callCompanyAI,
    isAIReachable: companyAIReachable,
  });

  if (checkOnly) {
    await capability.checkConfiguration();
    console.log('Company AI connectivity, token, protocol, and model are valid.');
    return;
  }

  const controller = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(`Balance skill runner ${runnerId} started; AI token remains local.`);
  await presence.start();
  try {
    await runSerialCapability({
      runOne: capability.runOne,
      once,
      signal: controller.signal,
      onError: (error) => console.error(error.message),
    });
  } finally {
    await presence.stop();
  }
}

await main();
