import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultConfigPath,
  defaultRunLockPath,
  runCli,
  selectedCapabilities,
  type CliDependencies,
} from './cli.js';
import type { KeychainStore } from './keychain-store.js';
import * as v from 'valibot';
import { SecretKey } from './secure-store.js';
import { createSettingsStore } from './settings-store.js';

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

function memorySecureStore(initial: Partial<Record<SecretKey, string>> = {}) {
  const values = new Map<SecretKey, string>(
    Object.entries(initial).flatMap(([key, value]) => (v.is(SecretKey, key) ? [[key, value]] : [])),
  );
  const store: KeychainStore & { values: Map<SecretKey, string> } = {
    values,
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      if (value === null || value === undefined) values.delete(key);
      else values.set(key, value);
      return Promise.resolve();
    },
    promptSet: (key) => {
      values.set(key, 'prompted-secret');
      return Promise.resolve();
    },
  };
  return store;
}

async function harness(initialCredentials: Partial<Record<SecretKey, string>> = {}) {
  directory = await mkdtemp(join(tmpdir(), 'balance-agent-cli-'));
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    settingsStore: createSettingsStore(join(directory, 'settings.json')),
    secureStore: memorySecureStore(initialCredentials),
    write: (message: string) => {
      output.push(message);
    },
    writeError: (message: string) => {
      errors.push(message);
    },
  };
}

describe('Balance Agent CLI', () => {
  test('honors XDG config and state homes with standard fallbacks', () => {
    expect(defaultConfigPath({ xdgConfigHome: '/xdg/config', home: '/home/test' })).toBe(
      '/xdg/config/message-dashboard/balance-agent.json',
    );
    expect(defaultConfigPath({ xdgConfigHome: '', home: '/home/test' })).toBe(
      '/home/test/.config/message-dashboard/balance-agent.json',
    );
    expect(defaultRunLockPath({ xdgStateHome: '/xdg/state', home: '/home/test' })).toBe(
      '/xdg/state/message-dashboard/balance-agent-cli.lock',
    );
    expect(defaultRunLockPath({ xdgStateHome: '', home: '/home/test' })).toBe(
      '/home/test/.local/state/message-dashboard/balance-agent-cli.lock',
    );
  });

  test('validates capability names', () => {
    expect(selectedCapabilities('sms-ai')).toEqual(['sms_ai']);
    expect(selectedCapabilities('carrier-browser')).toEqual(['carrier_browser']);
    expect(() => selectedCapabilities('unicom-browser')).toThrow('Unknown capability');
    expect(() => selectedCapabilities('unknown')).toThrow('Unknown capability');
  });

  test('saves non-secret configuration and reports local status', async () => {
    const context = await harness({ auth0RefreshToken: 'refresh', aiToken: 'secret' });
    const configured = await runCli(
      [
        'configure',
        '--dashboard-url',
        'https://dashboard.example',
        '--auth0-issuer',
        'https://tenant.example',
        '--auth0-client-id',
        'native-client',
        '--auth0-audience',
        'dashboard-api',
        '--ai-base-url',
        'https://ai.example',
        '--ai-model',
        'company-model',
      ],
      {
        settingsStore: context.settingsStore,
        secureStore: context.secureStore,
        output: context.write,
        error: context.writeError,
      },
    );
    expect(configured).toBe(0);

    const status = await runCli(['status'], {
      settingsStore: context.settingsStore,
      secureStore: context.secureStore,
      output: context.write,
      error: context.writeError,
    });
    expect(status).toBe(0);
    expect(context.output).toContain('Configuration: ready');
    expect(context.output).toContain('Authentication: signed in');
    expect(context.output.join('\n')).not.toContain('secret');
  });

  test('stores and clears the AI token only through the secure store', async () => {
    const context = await harness();
    expect(
      await runCli(['credentials', 'set-ai-token'], {
        secureStore: context.secureStore,
        settingsStore: context.settingsStore,
        output: context.write,
        error: context.writeError,
      }),
    ).toBe(0);
    expect(context.secureStore.values.get('aiToken')).toBe('prompted-secret');

    expect(
      await runCli(['credentials', 'clear-ai-token'], {
        secureStore: context.secureStore,
        settingsStore: context.settingsStore,
        output: context.write,
        error: context.writeError,
      }),
    ).toBe(0);
    expect(context.secureStore.values.get('aiToken')).toBeUndefined();
  });

  test('rejects secret-shaped and invalid configuration options', async () => {
    const context = await harness();
    const result = await runCli(['configure', '--ai-token', 'do-not-accept'], {
      settingsStore: context.settingsStore,
      secureStore: context.secureStore,
      output: context.write,
      error: context.writeError,
    });
    expect(result).toBe(1);
    expect(context.errors[0]).toContain('Unknown option');
  });

  test('runs one selected capability and always shuts the service down', async () => {
    const context = await harness();
    await context.settingsStore.save({
      dashboardUrl: 'https://dashboard.example',
      auth0Issuer: 'https://tenant.example',
      auth0ClientId: 'native-client',
      auth0Audience: 'dashboard-api',
      aiBaseUrl: 'https://ai.example',
      aiModel: 'company-model',
      aiProtocol: 'anthropic',
      installationName: 'Test runner',
      installationId: 'installation-1',
    });
    const events: string[] = [];
    let serviceOptions: Parameters<NonNullable<CliDependencies['createService']>>[0] | undefined;
    const result = await runCli(['run', '--capability', 'sms-ai', '--once'], {
      settingsStore: context.settingsStore,
      secureStore: context.secureStore,
      output: context.write,
      error: context.writeError,
      acquireLock: () =>
        Promise.resolve(() => {
          events.push('unlock');
          return Promise.resolve();
        }),
      createService: (options) => {
        serviceOptions = options;
        return {
          initialize: () => {
            events.push('initialize');
            return Promise.resolve();
          },
          snapshot: () =>
            Promise.resolve({ auth: 'signed_in', smsAi: 'ready', browser: 'stopped' }),
          wait: () => {
            events.push('wait');
            return Promise.resolve();
          },
          shutdown: () => {
            events.push('shutdown');
            return Promise.resolve();
          },
        };
      },
    });

    expect(result).toBe(0);
    expect(serviceOptions).toMatchObject({ enabledCapabilities: ['sms_ai'], once: true });
    expect(events).toEqual(['initialize', 'wait', 'shutdown', 'unlock']);
  });
});
