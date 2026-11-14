import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BLANK_SETTINGS } from './ipc/contract.js';
import { createSettingsStore } from './settings-store.js';
import { failureOf } from './test-support/failure-of.js';

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

async function settingsPath(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'balance-agent-settings-'));
  return join(directory, 'settings.json');
}

describe('settings store', () => {
  test('starts blank and saves trimmed values', async () => {
    const store = createSettingsStore(await settingsPath());
    expect(await store.load()).toEqual(BLANK_SETTINGS);

    const saved = await store.save({ dashboardUrl: ' https://dashboard.example ', aiModel: 'm' });
    expect(saved).toEqual({
      ...BLANK_SETTINGS,
      dashboardUrl: 'https://dashboard.example',
      aiModel: 'm',
    });
    expect(await store.load()).toEqual(saved);
  });

  test('drops keys it does not know and fills missing ones', async () => {
    const filePath = await settingsPath();
    await writeFile(filePath, JSON.stringify({ aiModel: 'm', stray: 'x' }));
    const loaded = await createSettingsStore(filePath).load();
    expect(loaded).toEqual({ ...BLANK_SETTINGS, aiModel: 'm' });
    expect(await readFile(filePath, 'utf8')).toContain('stray');
  });

  test('refuses a settings file of the wrong shape', async () => {
    const filePath = await settingsPath();
    const store = createSettingsStore(filePath);
    for (const text of ['not json', '{"aiModel": 5}', 'null']) {
      await writeFile(filePath, text);
      expect(await failureOf(store.load())).toContain('Settings file is not valid');
    }
  });
});
