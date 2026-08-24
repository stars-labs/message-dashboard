import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultConfigPath,
  defaultRunLockPath,
  runCli,
  selectedCapabilities,
} from './cli.js';
import { createSettingsStore } from './settings-store.js';

let directory;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

function memorySecureStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) { return values[key] || null; },
    async set(key, value) {
      if (value == null) delete values[key];
      else values[key] = value;
    },
    async promptSet(key) { values[key] = 'prompted-secret'; },
  };
}

async function harness(initialCredentials = {}) {
  directory = await mkdtemp(join(tmpdir(), 'balance-agent-cli-'));
  const output = [];
  const errors = [];
  return {
    output,
    errors,
    settingsStore: createSettingsStore(join(directory, 'settings.json')),
    secureStore: memorySecureStore(initialCredentials),
    write: (message) => output.push(message),
    writeError: (message) => errors.push(message),
  };
}

describe('Balance Agent CLI', () => {
  test('honors XDG config and state homes with standard fallbacks', () => {
    expect(defaultConfigPath({ xdgConfigHome: '/xdg/config', home: '/home/test' }))
      .toBe('/xdg/config/message-dashboard/balance-agent.json');
    expect(defaultConfigPath({ xdgConfigHome: '', home: '/home/test' }))
      .toBe('/home/test/.config/message-dashboard/balance-agent.json');
    expect(defaultRunLockPath({ xdgStateHome: '/xdg/state', home: '/home/test' }))
      .toBe('/xdg/state/message-dashboard/balance-agent-cli.lock');
    expect(defaultRunLockPath({ xdgStateHome: '', home: '/home/test' }))
      .toBe('/home/test/.local/state/message-dashboard/balance-agent-cli.lock');
  });

  test('validates capability names', () => {
    expect(selectedCapabilities('sms-ai')).toEqual(['sms_ai']);
    expect(selectedCapabilities('carrier-browser')).toEqual(['carrier_browser']);
    expect(() => selectedCapabilities('unicom-browser')).toThrow('Unknown capability');
    expect(() => selectedCapabilities('unknown')).toThrow('Unknown capability');
  });

  test('saves non-secret configuration and reports local status', async () => {
    const context = await harness({ auth0RefreshToken: 'refresh', aiToken: 'secret' });
    const configured = await runCli([
      'configure',
      '--dashboard-url', 'https://dashboard.example',
      '--auth0-issuer', 'https://tenant.example',
      '--auth0-client-id', 'native-client',
      '--auth0-audience', 'dashboard-api',
      '--ai-base-url', 'https://ai.example',
      '--ai-model', 'company-model',
    ], {
      settingsStore: context.settingsStore,
      secureStore: context.secureStore,
      output: context.write,
      error: context.writeError,
    });
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
    expect(await runCli(['credentials', 'set-ai-token'], {
      secureStore: context.secureStore,
      settingsStore: context.settingsStore,
      output: context.write,
      error: context.writeError,
    })).toBe(0);
    expect(context.secureStore.values.aiToken).toBe('prompted-secret');

    expect(await runCli(['credentials', 'clear-ai-token'], {
      secureStore: context.secureStore,
      settingsStore: context.settingsStore,
      output: context.write,
      error: context.writeError,
    })).toBe(0);
    expect(context.secureStore.values.aiToken).toBeUndefined();
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
    const events = [];
    let serviceOptions;
    const result = await runCli(['run', '--capability', 'sms-ai', '--once'], {
      settingsStore: context.settingsStore,
      secureStore: context.secureStore,
      output: context.write,
      error: context.writeError,
      acquireLock: async () => async () => { events.push('unlock'); },
      createService: (options) => {
        serviceOptions = options;
        return {
          async initialize() { events.push('initialize'); },
          async snapshot() {
            return { auth: 'signed_in', smsAi: 'ready', browser: 'stopped' };
          },
          async wait() { events.push('wait'); },
          async shutdown() { events.push('shutdown'); },
        };
      },
    });

    expect(result).toBe(0);
    expect(serviceOptions.enabledCapabilities).toEqual(['sms_ai']);
    expect(serviceOptions.once).toBe(true);
    expect(events).toEqual(['initialize', 'wait', 'shutdown', 'unlock']);
  });
});
