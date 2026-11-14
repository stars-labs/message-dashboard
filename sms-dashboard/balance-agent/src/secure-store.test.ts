import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { failureOf } from './test-support/failure-of.js';
import { createSecureStore, type SafeStorage } from './secure-store.js';

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe('desktop secure store', () => {
  test('persists only encrypted values and can remove one credential', async () => {
    directory = await mkdtemp(join(tmpdir(), 'balance-agent-secure-store-'));
    const filePath = join(directory, 'credentials.json');
    const safeStorage: SafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`sealed:${value}`),
      decryptString: (value) => value.toString().replace(/^sealed:/, ''),
    };
    const store = createSecureStore({ filePath, safeStorage });

    await store.set('aiToken', 'company-secret');
    expect(await store.get('aiToken')).toBe('company-secret');
    expect(await readFile(filePath, 'utf8')).not.toContain('company-secret');
    await store.set('aiToken', null);
    expect(await store.get('aiToken')).toBe(null);
  });

  test('fails closed when operating-system encryption is unavailable', async () => {
    directory = await mkdtemp(join(tmpdir(), 'balance-agent-secure-store-'));
    const store = createSecureStore({
      filePath: join(directory, 'credentials.json'),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
    });
    expect(await failureOf(store.set('aiToken', 'secret'))).toContain('encryption is unavailable');
    expect(await store.get('aiToken')).toBe(null);
  });
});
