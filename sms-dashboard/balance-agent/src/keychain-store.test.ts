import { describe, expect, test } from 'bun:test';
import { failureOf } from './test-support/failure-of.js';
import { createKeychainStore, type RunCommand } from './keychain-store.js';

interface Invocation {
  args: string[];
  options: Parameters<RunCommand>[1];
}

function recordingRunner(invocations: Invocation[]): RunCommand {
  return (args, options) => {
    invocations.push({ args, options });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

describe('Balance Agent CLI Keychain store', () => {
  test('writes credentials through stdin instead of command arguments', async () => {
    const invocations: Invocation[] = [];
    const store = createKeychainStore({
      platform: 'darwin',
      runCommand: recordingRunner(invocations),
    });

    await store.set('auth0RefreshToken', 'refresh-secret');

    expect(invocations[0]?.args).toEqual([
      'add-generic-password',
      '-a',
      'auth0RefreshToken',
      '-s',
      'io.qzz.message-dashboard.balance-agent.cli',
      '-U',
      '-w',
    ]);
    expect(invocations[0]?.args).not.toContain('refresh-secret');
    expect(invocations[0]?.options).toEqual({ input: 'refresh-secret' });
  });

  test('reads a credential without exposing it in an error', async () => {
    const store = createKeychainStore({
      platform: 'darwin',
      runCommand: () => Promise.resolve({ code: 0, stdout: 'stored-secret\n', stderr: '' }),
    });
    expect(await store.get('aiToken')).toBe('stored-secret');
  });

  test('treats a missing credential as empty and rejects unsupported systems', async () => {
    const missing = createKeychainStore({
      platform: 'darwin',
      runCommand: () =>
        Promise.resolve({
          code: 44,
          stdout: '',
          stderr: 'The specified item could not be found in the keychain.',
        }),
    });
    expect(await missing.get('aiToken')).toBe(null);

    const unsupported = createKeychainStore({ platform: 'linux' });
    expect(await failureOf(unsupported.get('aiToken'))).toContain('supports macOS only');
  });

  test('delegates interactive token entry directly to Keychain', async () => {
    const invocations: Invocation[] = [];
    const store = createKeychainStore({
      platform: 'darwin',
      runCommand: recordingRunner(invocations),
    });
    await store.promptSet('aiToken');
    expect(invocations[0]?.options).toEqual({ inherit: true });
    expect(invocations[0]?.args.at(-1)).toBe('-w');
  });
});
