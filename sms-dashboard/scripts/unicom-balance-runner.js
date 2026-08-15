import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createControlClient } from '../runner-core/control-client.js';
import { createRunnerPresence } from '../runner-core/presence.js';
import { runSerialCapability } from '../runner-core/serial-runner.js';
import { createUnicomBrowserCapability } from '../runner-core/capabilities/unicom-browser.js';
import { createUnicomBrowserJobProcessor } from '../runner-core/capabilities/unicom-browser-workflow.js';

const apiUrl = process.env.SMS_API_URL || 'https://sexy.qzz.io';
const apiKey = process.env.API_KEY;
const executablePath = process.env.UNICOM_BROWSER_EXECUTABLE || defaultBrowserExecutable();
const runnerId = process.env.UNICOM_BALANCE_RUNNER_ID
  || `${hostname()}-unicom-${randomUUID().slice(0, 8)}`;
const agentId = process.env.BALANCE_AGENT_ID || `${hostname()}-legacy`;
const once = process.argv.includes('--once');

function defaultBrowserExecutable() {
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return process.env.CHROME_BIN || '/usr/bin/google-chrome';
}

async function main() {
  if (!apiKey) throw new Error('Missing required environment: API_KEY');
  const controlClient = createControlClient({ baseUrl: apiUrl, apiKey });
  const presence = createRunnerPresence({
    controlClient,
    runnerId: agentId,
    sessionId: runnerId,
    displayName: hostname(),
    capability: 'unicom_browser',
    version: process.env.BALANCE_AGENT_VERSION || 'development',
    platform: process.platform,
  });
  const processor = createUnicomBrowserJobProcessor({
    controlClient,
    presence,
    runnerId,
    browser: chromium,
    executablePath,
  });
  const capability = createUnicomBrowserCapability({
    controlClient,
    presence,
    runnerId,
    processJob: processor.processJob,
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(`China Unicom browser balance runner ${runnerId} started.`);
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
