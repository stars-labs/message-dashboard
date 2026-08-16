import { describe, expect, test } from 'bun:test';
import { createKeychainStore } from './keychain-store.js';

describe('Balance Agent CLI Keychain store', () => {
  test('writes credentials through stdin instead of command arguments', async () => {
    let invocation;
    const store = createKeychainStore({
      platform: 'darwin',
      runCommand: async (args, options) => {
        invocation = { args, options };
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    await store.set('auth0RefreshToken', 'refresh-secret');

    expect(invocation.args).toEqual([
      'add-generic-password',
      '-a', 'auth0RefreshToken',
      '-s', 'io.qzz.message-dashboard.balance-agent.cli',
      '-U', '-w',
    ]);
    expect(invocation.args).not.toContain('refresh-secret');
    expect(invocation.options).toEqual({ input: 'refresh-secret' });
  });

  test('reads a credential without exposing it in an error', async () => {
    const store = createKeychainStore({
      platform: 'darwin',
      runCommand: async () => ({ code: 0, stdout: 'stored-secret\n', stderr: '' }),
    });
    expect(await store.get('aiToken')).toBe('stored-secret');
  });

  test('treats a missing credential as empty and rejects unsupported systems', async () => {
    const missing = createKeychainStore({
      platform: 'darwin',
      runCommand: async () => ({
        code: 44,
        stdout: '',
        stderr: 'The specified item could not be found in the keychain.',
      }),
    });
    expect(await missing.get('aiToken')).toBe(null);

    const unsupported = createKeychainStore({ platform: 'linux' });
    await expect(unsupported.get('aiToken')).rejects.toThrow('supports macOS only');
  });

  test('delegates interactive token entry directly to Keychain', async () => {
    let invocation;
    const store = createKeychainStore({
      platform: 'darwin',
      runCommand: async (args, options) => {
        invocation = { args, options };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await store.promptSet('aiToken');
    expect(invocation.options).toEqual({ inherit: true });
    expect(invocation.args.at(-1)).toBe('-w');
  });
});
