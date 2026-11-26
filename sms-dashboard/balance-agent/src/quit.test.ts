import { describe, expect, test } from 'bun:test';
import { shutdownThenExit } from './quit.js';

describe('Balance Agent quit', () => {
  test('exits with 0 once the service has shut down', async () => {
    const events: string[] = [];
    await shutdownThenExit({
      shutdown: () => {
        events.push('shutdown');
        return Promise.resolve();
      },
      exit: (code) => {
        events.push(`exit ${String(code)}`);
      },
      logger: {
        error: (message) => {
          events.push(`error ${message}`);
        },
      },
    });
    expect(events).toEqual(['shutdown', 'exit 0']);
  });

  test('still exits, with 1, when the shutdown fails', async () => {
    const events: string[] = [];
    await shutdownThenExit({
      shutdown: () => Promise.reject(new Error('heartbeat refused')),
      exit: (code) => {
        events.push(`exit ${String(code)}`);
      },
      logger: {
        error: (message) => {
          events.push(`error ${message}`);
        },
      },
    });
    expect(events).toEqual(['error Balance Agent shutdown failed: heartbeat refused', 'exit 1']);
  });
});
