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
      capability: 'unicom_browser',
      version: '1.0.0',
      platform: 'darwin',
    });

    await presence.start();
    await presence.set('busy', 'job-1', 'human_verification_required');
    await presence.stop();

    expect(bodies.map((body) => body.capabilities[0].state))
      .toEqual(['starting', 'busy', 'stopping']);
    expect(bodies[1].capabilities[0]).toMatchObject({
      capability: 'unicom_browser',
      current_job_id: 'job-1',
      detail_code: 'human_verification_required',
    });
    expect(JSON.stringify(bodies)).not.toContain('token');
    expect(JSON.stringify(bodies)).not.toContain('API_KEY');
  });
});
