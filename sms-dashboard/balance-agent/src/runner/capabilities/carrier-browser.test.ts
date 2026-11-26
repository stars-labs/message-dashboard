import { describe, expect, test } from 'bun:test';
import type { CarrierWebBalanceJob } from '../../../../shared/api/carrier-web-balance.js';
import { fakeControlClient, pacedAnswer } from '../../test-support/control-client.js';
import { createCarrierBrowserCapability } from './carrier-browser.js';

function webJob(id: string, simIndex: number | null): CarrierWebBalanceJob {
  return {
    id,
    check_id: 'check-1',
    sim_iccid: '8986000000000000001',
    sim_number: null,
    sim_index: simIndex,
    login_url: 'https://imgxx.client.10010.com/login',
    otp_requested_at: null,
    skill: { id: 'unicom-web-balance' },
  };
}

describe('carrier browser capability', () => {
  test('claims one job and reports its lifecycle', async () => {
    const states: unknown[][] = [];
    const jobs: CarrierWebBalanceJob[] = [];
    const { client, sent } = fakeControlClient(() => pacedAnswer(webJob('web-job-1', 36)));
    const capability = createCarrierBrowserCapability({
      controlClient: client,
      presence: {
        set: (...value) => {
          states.push(value);
          return Promise.resolve();
        },
      },
      runnerId: 'browser-session',
      processJob: (job) => {
        jobs.push(job);
        return Promise.resolve({ handled: true, retryDelay: 0 });
      },
    });

    expect(await capability.runOne()).toEqual({ handled: true, retryDelay: 0 });
    expect(jobs).toEqual([webJob('web-job-1', 36)]);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/control/carrier-web-balance/jobs/claim?runner_id=browser-session',
    ]);
    expect(states).toEqual([['busy', 'web-job-1'], ['ready']]);
  });

  test('does not launch a browser when the queue is empty, and claims again when told', async () => {
    let processed = false;
    const capability = createCarrierBrowserCapability({
      controlClient: fakeControlClient(() => pacedAnswer(null, '17')).client,
      presence: { set: () => Promise.resolve() },
      runnerId: 'browser-session',
      processJob: () => {
        processed = true;
        return Promise.resolve({ handled: true, retryDelay: 0 });
      },
    });

    expect(await capability.runOne()).toEqual({ handled: false, retryDelay: 17_000 });
    expect(processed).toBe(false);
  });

  test('restores ready state when browser processing throws', async () => {
    const states: unknown[][] = [];
    const capability = createCarrierBrowserCapability({
      controlClient: fakeControlClient(() => pacedAnswer(webJob('web-job-2', null))).client,
      presence: {
        set: (...value) => {
          states.push(value);
          return Promise.resolve();
        },
      },
      runnerId: 'browser-session',
      processJob: () => Promise.reject(new Error('browser closed')),
    });

    const outcome = await capability.runOne().then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(outcome).toEqual(new Error('browser closed'));
    expect(states).toEqual([['busy', 'web-job-2'], ['ready']]);
  });
});
