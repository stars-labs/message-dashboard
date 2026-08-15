import { readFile, rename, writeFile } from 'node:fs/promises';

const ALLOWED_KEYS = [
  'dashboardUrl', 'auth0Issuer', 'auth0ClientId', 'auth0Audience',
  'aiBaseUrl', 'aiModel', 'aiProtocol', 'installationName', 'installationId',
];

export function createSettingsStore(filePath) {
  return Object.freeze({
    async load() {
      try {
        const source = JSON.parse(await readFile(filePath, 'utf8'));
        return Object.fromEntries(ALLOWED_KEYS.map((key) => [key, String(source[key] || '')]));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    },
    async save(input) {
      const settings = Object.fromEntries(ALLOWED_KEYS.map((key) => [key, String(input[key] || '').trim()]));
      const temporaryPath = `${filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, filePath);
      return settings;
    },
  });
}
