import { readFile, rename, writeFile } from 'node:fs/promises';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';

export const SecretKey = v.picklist(['aiToken', 'auth0RefreshToken']);

export type SecretKey = v.InferOutput<typeof SecretKey>;

const SecretsFile = v.record(SecretKey, v.string());

type Secrets = Map<string, string>;

export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecureStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string | null | undefined): Promise<void>;
  clear(): Promise<void>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function createSecureStore({
  filePath,
  safeStorage,
}: {
  filePath: string;
  safeStorage: SafeStorage;
}): SecureStore {
  async function readAll(): Promise<Secrets> {
    let source: string;
    try {
      source = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return new Map();
      throw error;
    }
    const parsed = parseJson(source, SecretsFile);
    if (!parsed.ok) throw new Error(`Credential file is not valid: ${parsed.error}`);
    return new Map(Object.entries(parsed.value));
  }

  async function writeAll(value: Secrets): Promise<void> {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(value), null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  }

  return Object.freeze<SecureStore>({
    async get(key) {
      const value = (await readAll()).get(key);
      if (!value) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    },
    async set(key, value) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Operating-system credential encryption is unavailable');
      }
      const all = await readAll();
      if (value === null || value === undefined || value === '') all.delete(key);
      else all.set(key, safeStorage.encryptString(value).toString('base64'));
      await writeAll(all);
    },
    async clear() {
      await writeAll(new Map());
    },
  });
}
