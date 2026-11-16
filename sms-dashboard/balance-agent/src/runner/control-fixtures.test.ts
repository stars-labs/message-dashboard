// The agent's side of the runner fixtures the Worker is replayed against
// (sms-dashboard/server/control-fixtures.test.ts): the agent must send the
// recorded requests and act on the recorded answers.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  CarrierWebBalanceOtpWire,
  WebJobActionResponse,
  WebJobHeartbeatResponse,
} from '../../../shared/api/carrier-web-balance.js';
import type { ControlFixture } from '../../../shared/control-fixtures/fixture.js';
import { fakeControlClient, type Sent } from '../test-support/control-client.js';
import { recordedResponse, runnerFixture } from '../test-support/control-fixtures.js';
import { createCarrierBrowserCapability } from './capabilities/carrier-browser.js';
import { createSmsAiCapability } from './capabilities/sms-ai.js';
import type { ControlClient } from './control-client.js';
import { createRunnerPresence } from './presence.js';

/** A control client that answers with the given fixtures, in order, and records what it was sent. */
function replaying(...fixtures: ControlFixture[]): { client: ControlClient; sent: Sent[] } {
  const queue = [...fixtures];
  return fakeControlClient(({ path }) => {
    const next = queue.shift();
    if (!next) throw new Error(`no recorded answer for ${path}`);
    return recordedResponse(next);
  });
}

function recorded({ request }: ControlFixture): Sent {
  return { method: request.method, path: request.path, body: request.body };
}

const presence = { set: () => Promise.resolve() };
const quiet = { log: () => undefined, error: () => undefined };

function smsAi(client: ControlClient, callAI: () => Promise<unknown>) {
  return createSmsAiCapability({
    controlClient: client,
    presence,
    runnerId: 'runner-1',
    aiBaseUrl: 'https://ai.example',
    aiToken: 'not-observed',
    aiModel: 'company-model',
    callAI,
    isAIReachable: () => Promise.resolve(true),
    logger: quiet,
  });
}

describe('runner fixtures', () => {
  test('presence sends the recorded heartbeat', async () => {
    const heartbeat = runnerFixture('balance-runners-heartbeat');
    const { client, sent } = replaying(heartbeat, heartbeat);
    const runner = createRunnerPresence({
      controlClient: client,
      runnerId: 'runner-1',
      sessionId: 'runner-session-1',
      displayName: 'Workstation',
      capabilities: ['sms_ai'],
      version: '1.0.0',
      platform: 'darwin',
      setIntervalFn: () => setTimeout(() => undefined, 0),
      clearIntervalFn: () => undefined,
      logger: quiet,
    });

    await runner.start();
    await runner.set('sms_ai', 'ready');

    expect(sent.at(-1)).toEqual(recorded(heartbeat));
  });

  test('sms-ai claims the recorded job and submits the recorded decision', async () => {
    const claim = runnerFixture('balance-skills-claim');
    const decision = runnerFixture('balance-skills-decision');
    const { client, sent } = replaying(claim, decision);

    const outcome = await smsAi(client, () =>
      Promise.resolve({ action: 'reply', selected_option: '11', confidence: 0.98 }),
    ).runOne();

    expect(outcome).toEqual({ handled: true, retryDelay: 0 });
    expect(sent).toEqual([recorded(claim), recorded(decision)]);
  });

  test('sms-ai releases the recorded job when the model fails', async () => {
    const claim = runnerFixture('balance-skills-claim');
    const release = runnerFixture('balance-skills-release');
    const { client, sent } = replaying(claim, release);

    await smsAi(client, () => Promise.reject(new Error('model timed out'))).runOne();

    expect(sent).toEqual([recorded(claim), recorded(release)]);
  });

  test('sms-ai waits when the recorded claim finds no job', async () => {
    const empty = runnerFixture('balance-skills-claim.empty');
    const { client, sent } = replaying(empty);

    const outcome = await smsAi(client, () =>
      Promise.reject(new Error('AI must not run')),
    ).runOne();

    expect(outcome).toEqual({ handled: false, retryDelay: 5_000 });
    expect(sent).toEqual([recorded(empty)]);
  });

  test('carrier-browser claims the recorded job and hands it over whole', async () => {
    const claim = runnerFixture('carrier-web-claim');
    const { client, sent } = replaying(claim);
    const processed: unknown[] = [];

    await createCarrierBrowserCapability({
      controlClient: client,
      presence,
      runnerId: 'runner-1',
      processJob: (job) => {
        processed.push(job);
        return Promise.resolve({ handled: true, retryDelay: 0 });
      },
    }).runOne();

    expect(sent).toEqual([recorded(claim)]);
    expect(processed).toEqual([claim.response.body]);
  });

  test('carrier-browser waits when the recorded claim finds no job', async () => {
    const empty = runnerFixture('carrier-web-claim.empty');
    const { client } = replaying(empty);

    const outcome = await createCarrierBrowserCapability({
      controlClient: client,
      presence,
      runnerId: 'runner-1',
      processJob: () => Promise.reject(new Error('no job was claimed')),
    }).runOne();

    expect(outcome).toEqual({ handled: false, retryDelay: 5_000 });
  });

  test('every recorded job answer fits the contract the client checks it against', () => {
    for (const name of [
      'carrier-web-otp-requested',
      'carrier-web-complete',
      'carrier-web-fail',
      'carrier-web-release',
    ]) {
      const { response } = runnerFixture(name);
      expect([name, v.is(WebJobActionResponse, response.body)]).toEqual([name, true]);
    }
    expect(
      v.is(WebJobHeartbeatResponse, runnerFixture('carrier-web-heartbeat').response.body),
    ).toBe(true);
    expect(
      v.parse(CarrierWebBalanceOtpWire, runnerFixture('carrier-web-otp').response.body),
    ).toEqual({ code: '654321' });
    expect(
      v.parse(CarrierWebBalanceOtpWire, runnerFixture('carrier-web-otp.cursor').response.body),
    ).toMatchObject({ code: null, cursor: { source_message_id: 'promo-1' } });
    expect(runnerFixture('carrier-web-otp.empty').response.status).toBe(204);
  });

  test('the runner check sends the recorded request and reads its answer', async () => {
    const check = runnerFixture('balance-runners-check');
    const { client, sent } = replaying(check);

    expect(await client.balanceRunnerControl.check()).toEqual({ success: true });
    expect(sent).toEqual([recorded(check)]);
  });
});
