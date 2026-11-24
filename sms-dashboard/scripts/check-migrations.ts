// Migrations reach production from main, so main's files are the applied ones.
// Usage: bun scripts/check-migrations.ts [base-ref]   (default origin/main)
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  baselineThrough,
  baselineViolations,
  isMigration,
  migrationViolations,
  type MigrationFile,
} from './migration-rules.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'migrations');
const base = process.argv[2] ?? 'origin/main';

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stderr: 'pipe' });
  if (!result.success) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

// Without --full-tree, ls-tree run from this subdirectory lists nothing.
const applied: MigrationFile[] = git([
  'ls-tree',
  '--full-tree',
  '--name-only',
  `${base}:./migrations`,
])
  .split('\n')
  .filter(isMigration)
  .map((name) => ({ name, sql: git(['show', `${base}:./migrations/${name}`]) }));

if (applied.length === 0) throw new Error(`no migrations found on ${base}`);

const current: MigrationFile[] = await Promise.all(
  (await readdir(dir))
    .filter(isMigration)
    .sort()
    .map(async (name) => ({ name, sql: await Bun.file(join(dir, name)).text() })),
);

const through = baselineThrough(await Bun.file(join(dir, 'schema.sql')).text());

const violations = [
  ...migrationViolations(applied, current),
  ...baselineViolations(through, applied),
];
if (violations.length > 0) {
  console.error(`Migrations against ${base}:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log(
  `${current.length} migrations; the ${applied.length} on ${base} are unchanged; schema.sql is through ${through}.`,
);
