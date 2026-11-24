// Docs that point at files which moved or never existed send agents the wrong way.
import { join } from 'node:path';
import { brokenDocLinks, repoPaths, type RepoFile } from './doc-link-rules.ts';

const root = join(import.meta.dirname, '../..');

const listed = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  stderr: 'inherit',
});
if (!listed.success) throw new Error('git ls-files failed');

const names = listed.stdout
  .toString()
  .split('\n')
  .filter((name) => name !== '');

const files: RepoFile[] = [];
for (const name of names) {
  const file = Bun.file(join(root, name));
  if (!(await file.exists())) continue; // deleted in the working tree, not yet staged
  const text = await file.text();
  if (!text.includes('\0')) files.push({ path: name, text });
}

const broken = brokenDocLinks(files, repoPaths(files.map((file) => file.path)));
if (broken.length > 0) {
  console.error(`Links to files that do not exist:\n${broken.join('\n')}`);
  process.exit(1);
}
