import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function bundle(config: Bun.BuildConfig) {
  const result = await Bun.build(config);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await bundle({
  entrypoints: [resolve(root, 'src/main.ts')],
  outdir: dist,
  target: 'node',
  format: 'esm',
  external: ['electron', 'playwright-core'],
  sourcemap: 'linked',
});

await bundle({
  entrypoints: [resolve(root, 'src/preload.ts')],
  outdir: dist,
  target: 'browser',
  format: 'cjs',
  naming: '[name].cjs',
  external: ['electron'],
});

await bundle({
  entrypoints: [resolve(root, 'src/renderer/renderer.ts')],
  outdir: resolve(dist, 'renderer'),
  target: 'browser',
  format: 'esm',
});

for (const file of ['index.html', 'styles.css']) {
  await cp(resolve(root, 'src/renderer', file), resolve(dist, 'renderer', file));
}
await cp(resolve(root, 'src/assets'), resolve(dist, 'assets'), { recursive: true });
