import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { commandRunner, startAgentSandbox, type Security } from './agent.ts';

async function failureOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => null,
    (caught: unknown) => caught,
  );
  return error instanceof Error ? error.message : 'did not fail';
}

function recordingSecurity(calls: (string[] | string)[]): Security {
  return (args, input) => {
    calls.push(args);
    if (input !== undefined) calls.push(`stdin: ${input}`);
    return Promise.resolve({ code: 0, stderr: '' });
  };
}

describe('Balance Agent sandbox', () => {
  test('gives the CLI its own config, state and Keychain service', async () => {
    const sandbox = await startAgentSandbox({ security: recordingSecurity([]) });
    try {
      expect(sandbox.env['XDG_CONFIG_HOME']).toStartWith(sandbox.root);
      expect(sandbox.env['XDG_STATE_HOME']).toStartWith(sandbox.root);
      expect(sandbox.service).toMatch(/^io\.qzz\.message-dashboard\.balance-agent\.verify-[\w-]+$/);
      expect(sandbox.env['BALANCE_AGENT_KEYCHAIN_SERVICE']).toBe(sandbox.service);
    } finally {
      await sandbox.stop();
    }
  });

  test('touches only its own Keychain service and removes both secrets and its files', async () => {
    const calls: (string[] | string)[] = [];
    const sandbox = await startAgentSandbox({ security: recordingSecurity(calls) });
    await sandbox.setAiToken('fake-ai-token');
    await sandbox.stop();

    expect(calls).toEqual([
      ['add-generic-password', '-a', 'aiToken', '-s', sandbox.service, '-U', '-w'],
      'stdin: fake-ai-token',
      ['delete-generic-password', '-a', 'aiToken', '-s', sandbox.service],
      ['delete-generic-password', '-a', 'auth0RefreshToken', '-s', sandbox.service],
    ]);
    expect(existsSync(sandbox.root)).toBe(false);
  });

  test('treats a secret that was never stored as already removed', async () => {
    const sandbox = await startAgentSandbox({
      security: (args) =>
        Promise.resolve(
          args[0] === 'delete-generic-password'
            ? { code: 44, stderr: 'The specified item could not be found in the keychain.' }
            : { code: 0, stderr: '' },
        ),
    });
    expect(await failureOf(sandbox.stop())).toBe('did not fail');
  });

  test('feeds a secret to the command twice, as security -w asks for it and a retype', async () => {
    const echoToStderr = commandRunner('/bin/sh');
    expect(await echoToStderr(['-c', 'cat >&2; exit 3'], 'token-1')).toEqual({
      code: 3,
      stderr: 'token-1\ntoken-1\n',
    });
  });

  test('runs the real CLI inside the sandbox', async () => {
    const sandbox = await startAgentSandbox({ security: recordingSecurity([]) });
    try {
      const help = await sandbox.cli(['help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('Balance Agent CLI');
    } finally {
      await sandbox.stop();
    }
  });

  test('still tries every secret and removes its files when a delete fails, then says so', async () => {
    const calls: (string[] | string)[] = [];
    const sandbox = await startAgentSandbox({
      security: (args) => {
        calls.push(args);
        return Promise.resolve({ code: 1, stderr: 'Access denied.' });
      },
    });
    expect(await failureOf(sandbox.stop())).toBe(
      'Keychain cleanup failed: aiToken: Access denied.; auth0RefreshToken: Access denied.',
    );
    expect(calls).toHaveLength(2);
    expect(existsSync(sandbox.root)).toBe(false);
  });

  test('reports a Keychain write that failed', async () => {
    const sandbox = await startAgentSandbox({
      security: (args) =>
        Promise.resolve(
          args[0] === 'add-generic-password'
            ? { code: 1, stderr: 'User interaction is not allowed.' }
            : { code: 0, stderr: '' },
        ),
    });
    try {
      expect(await failureOf(sandbox.setAiToken('x'))).toBe(
        'Keychain write failed: User interaction is not allowed.',
      );
    } finally {
      await sandbox.stop();
    }
  });
});
