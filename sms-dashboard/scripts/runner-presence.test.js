import { describe, expect, test } from 'bun:test';
import { createRunnerPresence } from './runner-presence.js';

describe('runner presence client', () => {
  test('reports lifecycle state without exposing configuration', async () => {
    const bodies = [];
    const presence = createRunnerPresence({
      controlClient: {
        request: async (_path, options) => {
          bodies.push(JSON.parse(options.body));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        },
      },
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

    expect(bodies).toHaveLength(4);
    expect(bodies[0].capabilities.map(({ capability, state }) => [capability, state]))
      .toEqual([['carrier_browser', 'starting'], ['sms_ai', 'starting']]);
    expect(bodies[2].capabilities[0]).toMatchObject({
      capability: 'carrier_browser',
      state: 'busy',
      current_job_id: 'job-1',
      detail_code: 'human_verification_required',
    });
    expect(bodies[3].capabilities.every(({ state }) => state === 'stopping')).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain('token');
    expect(JSON.stringify(bodies)).not.toContain('API_KEY');
  });

  test('periodic liveness omits unchanged capability state', async () => {
    const bodies = [];
    let heartbeat;
    const presence = createRunnerPresence({
      controlClient: {
        request: async (_path, options) => {
          bodies.push(JSON.parse(options.body));
          return new Response(null, { status: 200 });
        },
      },
      runnerId: 'workstation',
      sessionId: 'session-1',
      displayName: 'Workstation',
      capabilities: ['carrier_browser'],
      version: '1.0.0',
      platform: 'darwin',
      setIntervalFn: (callback) => {
        heartbeat = callback;
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });

    await presence.start();
    await heartbeat();

    expect(bodies.map(({ capabilities }) => capabilities.length)).toEqual([1, 0]);
  });
});
