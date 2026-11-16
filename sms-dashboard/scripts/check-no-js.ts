// Fails when the dashboard holds a JavaScript source file, tracked or about to
// be: every area is TypeScript, and a .js file would sit outside every tsconfig
// and lint rule. Generated and ignored files (dist/, server/frontend-assets.js)
// are not listed by git, so they do not count.
import { join } from 'node:path';

const listed = Bun.spawnSync(
  [
    'git',
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '*.js',
    '*.mjs',
    '*.cjs',
    '*.jsx',
  ],
  { cwd: join(import.meta.dirname, '..'), stderr: 'inherit' },
);
if (!listed.success) throw new Error('git ls-files failed');

const files = listed.stdout
  .toString()
  .split('\n')
  .filter((file) => file !== '');

if (files.length > 0) {
  console.error(`JavaScript source found; write it in TypeScript:\n${files.join('\n')}`);
  process.exit(1);
}
