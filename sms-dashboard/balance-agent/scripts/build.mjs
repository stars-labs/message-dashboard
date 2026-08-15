import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/main.js')],
  outdir: dist,
  target: 'node',
  format: 'esm',
  external: ['electron', 'playwright-core'],
  sourcemap: 'linked',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await cp(resolve(root, 'src/preload.cjs'), resolve(dist, 'preload.cjs'));
await cp(resolve(root, 'src/renderer'), resolve(dist, 'renderer'), { recursive: true });
await cp(resolve(root, 'src/assets'), resolve(dist, 'assets'), { recursive: true });
