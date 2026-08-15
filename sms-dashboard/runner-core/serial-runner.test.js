import { describe, expect, test } from 'bun:test';
import { runSerialCapability } from './serial-runner.js';

describe('serial capability runner', () => {
  test('never overlaps jobs', async () => {
    const controller = new AbortController();
    let active = 0;
    let maximumActive = 0;
    let runs = 0;

    await runSerialCapability({
      signal: controller.signal,
      sleep: async () => {},
      runOne: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        runs += 1;
        if (runs === 3) controller.abort();
        return { retryDelay: 0 };
      },
    });

    expect(runs).toBe(3);
    expect(maximumActive).toBe(1);
  });

  test('once mode propagates a job error', async () => {
    await expect(runSerialCapability({
      once: true,
      runOne: async () => { throw new Error('job failed'); },
      onError: () => {},
    })).rejects.toThrow('job failed');
  });
});
