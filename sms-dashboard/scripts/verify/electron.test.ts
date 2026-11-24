import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electronBinary } from './electron.ts';

describe('Balance Agent app launcher', () => {
  test('finds the binary the electron package installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electron-test-'));
    try {
      await writeFile(join(root, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
      expect(await electronBinary(root)).toBe(
        join(root, 'dist', 'Electron.app/Contents/MacOS/Electron'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('says how to install the binary when bun skipped it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electron-test-'));
    try {
      const failure = await electronBinary(root).then(
        () => 'did not fail',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failure).toBe(
        'Electron is not installed (bun skips its postinstall): run `node node_modules/electron/install.js` in sms-dashboard/',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
