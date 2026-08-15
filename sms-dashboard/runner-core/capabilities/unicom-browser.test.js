import { describe, expect, test } from 'bun:test';
import { createUnicomBrowserCapability } from './unicom-browser.js';

describe('China Unicom browser capability', () => {
  test('claims one job and reports its lifecycle', async () => {
    const states = [];
    const jobs = [];
    const capability = createUnicomBrowserCapability({
      controlClient: {
        request: async () => new Response(JSON.stringify({ id: 'web-job-1', sim_index: 36 })),
      },
      presence: { set: async (...value) => states.push(value) },
      runnerId: 'browser-session',
      processJob: async (job) => {
        jobs.push(job);
        return { handled: true, retryDelay: 0 };
      },
    });

    expect(await capability.runOne()).toEqual({ handled: true, retryDelay: 0 });
    expect(jobs).toEqual([{ id: 'web-job-1', sim_index: 36 }]);
    expect(states).toEqual([['ready'], ['busy', 'web-job-1'], ['ready']]);
  });

  test('does not launch a browser when the queue is empty', async () => {
    let processed = false;
    const capability = createUnicomBrowserCapability({
      controlClient: { request: async () => new Response(null, { status: 204 }) },
      presence: { set: async () => {} },
      runnerId: 'browser-session',
      processJob: async () => { processed = true; },
    });

    expect(await capability.runOne()).toEqual({ handled: false, retryDelay: 5_000 });
    expect(processed).toBe(false);
  });

  test('restores ready state when browser processing throws', async () => {
    const states = [];
    const capability = createUnicomBrowserCapability({
      controlClient: {
        request: async () => new Response(JSON.stringify({ id: 'web-job-2' })),
      },
      presence: { set: async (...value) => states.push(value) },
      runnerId: 'browser-session',
      processJob: async () => { throw new Error('browser closed'); },
    });

    await expect(capability.runOne()).rejects.toThrow('browser closed');
    expect(states).toEqual([['ready'], ['busy', 'web-job-2'], ['ready']]);
  });
});
