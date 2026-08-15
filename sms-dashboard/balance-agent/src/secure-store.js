import { readFile, rename, writeFile } from 'node:fs/promises';

export function createSecureStore({ filePath, safeStorage }) {
  async function readAll() {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeAll(value) {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  return Object.freeze({
    async get(key) {
      const value = (await readAll())[key];
      if (!value) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    },
    async set(key, value) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Operating-system credential encryption is unavailable');
      }
      const all = await readAll();
      if (value == null || value === '') delete all[key];
      else all[key] = safeStorage.encryptString(String(value)).toString('base64');
      await writeAll(all);
    },
    async clear() {
      await writeAll({});
    },
  });
}
