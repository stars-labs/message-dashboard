import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import { BLANK_SETTINGS, Settings } from './ipc/contract.js';

export type SettingsDraft = { readonly [K in keyof Settings]?: string | undefined };

export interface SettingsStore {
  load(): Promise<Settings>;
  save(input: SettingsDraft): Promise<Settings>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function createSettingsStore(filePath: string): SettingsStore {
  return Object.freeze<SettingsStore>({
    async load() {
      let source: string;
      try {
        source = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return BLANK_SETTINGS;
        throw error;
      }
      const parsed = parseJson(source, Settings);
      if (!parsed.ok) throw new Error(`Settings file is not valid: ${parsed.error}`);
      return parsed.value;
    },
    async save(input) {
      const parsed = v.safeParse(Settings, input);
      if (!parsed.success) throw new Error(`Settings are not valid: ${v.summarize(parsed.issues)}`);
      const temporaryPath = `${filePath}.tmp`;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(parsed.output, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
      return parsed.output;
    },
  });
}
