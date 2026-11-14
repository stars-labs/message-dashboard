import { describe, expect, test } from 'bun:test';
import { createAgentService, type ServiceState } from './agent-service.js';
import * as v from 'valibot';
import { BLANK_SETTINGS, Settings } from './ipc/contract.js';
import type { SecretKey } from './secure-store.js';
import type { SettingsStore } from './settings-store.js';
import { failureOf } from './test-support/failure-of.js';

function memorySettings() {
  let current = BLANK_SETTINGS;
  const store: SettingsStore = {
    load: () => Promise.resolve(current),
    save: (input) => {
      current = v.parse(Settings, input);
      return Promise.resolve(current);
    },
  };
  return store;
}

function harness() {
  const secrets = new Map<SecretKey, string>();
  const states: ServiceState[] = [];
  const service = createAgentService({
    settingsStore: memorySettings(),
    secureStore: {
      get: (key) => Promise.resolve(secrets.get(key) ?? null),
      set: (key, value) => {
        if (value === null || value === undefined || value === '') secrets.delete(key);
        else secrets.set(key, value);
        return Promise.resolve();
      },
    },
    openExternal: () => Promise.resolve(),
    onState: (state) => {
      states.push(state);
    },
  });
  return { service, secrets, states };
}

describe('Balance Agent service', () => {
  test('creates an installation id on first start and stays signed out without a login', async () => {
    const { service, states } = harness();
    await service.initialize();
    const snapshot = await service.snapshot();
    expect(snapshot.settings.installationId).not.toBe('');
    expect(snapshot.auth).toBe('signed_out');
    expect(states.at(-1)?.auth).toBe('signed_out');
  });

  test('keeps the AI token out of the settings file and reports that one is stored', async () => {
    const { service, secrets } = harness();
    await service.initialize();
    const snapshot = await service.saveSettings({ aiModel: ' model ', aiToken: 'secret' });
    expect(snapshot.settings.aiModel).toBe('model');
    expect(snapshot.hasAiToken).toBe(true);
    expect(JSON.stringify(snapshot.settings)).not.toContain('secret');
    expect(secrets.get('aiToken')).toBe('secret');
  });

  test('leaves the stored token alone when the form omits it', async () => {
    const { service, secrets } = harness();
    await service.initialize();
    await service.saveSettings({ aiToken: 'secret' });
    await service.saveSettings({ aiModel: 'model' });
    expect(secrets.get('aiToken')).toBe('secret');
  });

  test('refuses to sign in before the Dashboard and Auth0 are configured', async () => {
    const { service } = harness();
    await service.initialize();
    expect(await failureOf(service.signIn())).toBe('Save dashboard and Auth0 settings first');
  });

  test('reports an unusable AI configuration without calling the gateway', async () => {
    const { service } = harness();
    await service.initialize();
    const results = await service.testConfiguration({ aiProtocol: 'gemini', aiToken: 't' });
    expect(results.dashboard).toEqual({ ok: false, message: '请先登录 Dashboard' });
    expect(results.ai.ok).toBe(false);
    expect(results.browser).toEqual({ ok: false, message: '浏览器运行时不可用' });
  });
});
