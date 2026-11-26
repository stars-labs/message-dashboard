import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { fakeControlClient, jsonAnswer } from '../test-support/control-client.js';
import { createRunnerPresence } from './presence.js';

const Heartbeat = v.object({
  capabilities: v.array(
    v.object({
      capability: v.string(),
      state: v.string(),
      current_job_id: v.nullable(v.string()),
      detail_code: v.nullable(v.string()),
    }),
  ),
});

type Heartbeat = v.InferOutput<typeof Heartbeat>;

function heartbeatBody({ body }: { body: unknown }): Heartbeat {
  return v.parse(Heartbeat, body);
}

function accepting() {
  return fakeControlClient(() => jsonAnswer({ success: true, runner_id: 'workstation' }));
}

describe('runner presence client', () => {
  test('reports lifecycle state without exposing configuration', async () => {
    const { client, sent } = accepting();
    const presence = createRunnerPresence({
      controlClient: client,
      runnerId: 'workstation-legacy',
      sessionId: 'session-1',
      displayName: 'Workstation',
      capabilities: ['carrier_browser', 'sms_ai'],
      version: '1.0.0',
      platform: 'darwin',
    });

    await presence.start();
    await presence.set('carrier_browser', 'ready');
    await presence.set('carrier_browser', 'ready');
    await presence.set('carrier_browser', 'busy', 'job-1', 'human_verification_required');
    await presence.stop();

    const bodies = sent.map(heartbeatBody);
    expect(bodies).toHaveLength(4);
    expect(bodies[0]?.capabilities.map(({ capability, state }) => [capability, state])).toEqual([
      ['carrier_browser', 'starting'],
      ['sms_ai', 'starting'],
    ]);
    expect(bodies[2]?.capabilities[0]).toMatchObject({
      capability: 'carrier_browser',
      state: 'busy',
      current_job_id: 'job-1',
      detail_code: 'human_verification_required',
    });
    expect(bodies[3]?.capabilities.every(({ state }) => state === 'stopping')).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('token');
    expect(JSON.stringify(sent)).not.toContain('API_KEY');
  });

  test('passes on the Agent version the Dashboard announces', async () => {
    const latest = {
      version: '0.2.0',
      release_url:
        'https://github.com/stars-labs/message-dashboard/releases/tag/balance-agent-v0.2.0',
    };
    const { client } = fakeControlClient(() =>
      jsonAnswer({ success: true, runner_id: 'workstation', latest_agent: latest }),
    );
    const announced: unknown[] = [];
    const presence = createRunnerPresence({
      controlClient: client,
      runnerId: 'workstation',
      sessionId: 'session-1',
      displayName: 'Workstation',
      capabilities: ['sms_ai'],
      platform: 'darwin',
      onLatestAgent: (value) => {
        announced.push(value);
      },
    });

    await presence.start();

    expect(announced).toEqual([latest]);
  });

  test('announces nothing when an older Dashboard leaves the version out', async () => {
    const { client } = accepting();
    const announced: unknown[] = [];
    const presence = createRunnerPresence({
      controlClient: client,
      runnerId: 'workstation',
      sessionId: 'session-1',
      displayName: 'Workstation',
      capabilities: ['sms_ai'],
      platform: 'darwin',
      onLatestAgent: (value) => {
        announced.push(value);
      },
    });

    await presence.start();

    expect(announced).toEqual([]);
  });

  test('periodic liveness omits unchanged capability state', async () => {
    const { client, sent } = accepting();
    let heartbeat: (() => Promise<void>) | undefined;
    const presence = createRunnerPresence({
      controlClient: client,
      runnerId: 'workstation',
      sessionId: 'session-1',
      displayName: 'Workstation',
      capabilities: ['carrier_browser'],
      version: '1.0.0',
      platform: 'darwin',
      setIntervalFn: (callback) => {
        heartbeat = callback;
        return setTimeout(() => undefined, 0);
      },
      clearIntervalFn: () => undefined,
    });

    await presence.start();
    await heartbeat?.();

    expect(sent.map(heartbeatBody).map(({ capabilities }) => capabilities.length)).toEqual([1, 0]);
  });
});
