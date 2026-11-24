import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The Electron binary the `electron` package installed; bun skips that postinstall by default. */
export async function electronBinary(packageRoot = 'node_modules/electron'): Promise<string> {
  const relative = await readFile(join(packageRoot, 'path.txt'), 'utf8').catch(() => null);
  if (relative === null) {
    throw new Error(
      'Electron is not installed (bun skips its postinstall): run `node node_modules/electron/install.js` in sms-dashboard/',
    );
  }
  return join(packageRoot, 'dist', relative.trim());
}
