// bun run db:apply NNN [--max-rows-read N] [--max-rows-written N]
// Applies migration NNN to production: the next one after the baseline, as main holds
// it. It rehearses the migration on a copy of production and refuses one above the
// limits, records a Time Travel bookmark, applies it with `d1 execute --file`, compares
// table counts with the rehearsal, regenerates the baseline, checks it against
// production, and waits for a daemon heartbeat written after it. Commit the baseline
// files it rewrites.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  applyToProduction,
  countProduction,
  exportProduction,
  lastHeartbeat,
  migrationsDir,
  productionDrift,
  root,
  timeTravelBookmark,
} from './d1-remote.ts';
import { countChanges, migrationToApply, withBaselineHeader } from './migration-apply-rules.ts';
import { baselineThrough } from './migration-rules.ts';
import { rehearsalReport, REHEARSAL_OPTIONS, rehearseFile } from './rehearsal-command.ts';
import { REFERENCE_TABLES } from './schema-drift.ts';

const HEARTBEAT_WAIT_MS = 150_000;

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

const { values, positionals } = parseArgs({
  options: REHEARSAL_OPTIONS,
  allowPositionals: true,
  strict: true,
});
const [number] = positionals;
if (number === undefined || !/^\d{3}$/.test(number) || positionals.length > 1) {
  throw new Error('usage: bun run db:apply NNN [--max-rows-read N] [--max-rows-written N]');
}

const schemaFile = join(migrationsDir, 'schema.sql');
const referenceFile = join(migrationsDir, 'reference-data.sql');
const through = baselineThrough(await Bun.file(schemaFile).text());
const name = migrationToApply(await readdir(migrationsDir), through, number);
const file = join(migrationsDir, name);

if (git(['status', '--porcelain', '--', 'migrations']).trim() !== '') {
  throw new Error('migrations/ has uncommitted changes; db:apply rewrites the baseline there.');
}
git(['fetch', '--quiet', 'origin', 'main']);
const onMain = Bun.spawnSync(['git', 'show', `origin/main:./migrations/${name}`], {
  cwd: root,
  stdout: 'pipe',
});
if (!onMain.success || onMain.stdout.toString() !== (await Bun.file(file).text())) {
  throw new Error(`${name} is not on origin/main as it is here; production runs what main holds.`);
}

const { rehearsal, tables, violations } = await rehearseFile(file, values);
console.log(rehearsalReport(name, rehearsal));
if (violations.length > 0) {
  console.error(
    `${violations.join('\n')}\nNot applied. Batch the change across quota windows, or raise the limit once the account's remaining allowance covers it and the Worker's own traffic.`,
  );
  process.exit(1);
}

const bookmark = await timeTravelBookmark();
console.log(`\nTime Travel bookmark before ${name}: ${bookmark}`);
const restore = `bunx wrangler d1 time-travel restore sms-dashboard --bookmark=${bookmark}`;

const startedAt = new Date();
const before = await countProduction(tables);
const applied = await applyToProduction(file);
const after = await countProduction(tables);
console.log(
  `Applied ${name}: rows read ${String(applied.rowsRead)}, rows written ${String(applied.rowsWritten)}`,
);

const changes = countChanges(rehearsal.counts, { before, after });
for (const { table, production, rehearsal: expected } of changes) {
  console.log(
    `  ${table}: ${String(production)} rows in production, ${String(expected)} in the rehearsal`,
  );
}
const differing = changes.filter(({ production, rehearsal: expected }) => production !== expected);
if (differing.length > 0) {
  console.warn(
    `Row counts moved differently from the rehearsal. Live traffic accounts for new messages;\nanything else means the migration did not run as rehearsed. To undo it:\n  ${restore}`,
  );
}

const dir = await mkdtemp(join(tmpdir(), 'sms-dashboard-baseline-'));
try {
  const schema = join(dir, 'schema.sql');
  const reference = join(dir, 'reference-data.sql');
  await exportProduction(schema, ['--no-data']);
  await exportProduction(reference, [
    ...REFERENCE_TABLES.flatMap(({ table }) => ['--table', table]),
    '--no-schema',
  ]);
  const next = Number(number);
  await Bun.write(
    schemaFile,
    withBaselineHeader(await Bun.file(schemaFile).text(), await Bun.file(schema).text(), next),
  );
  await Bun.write(
    referenceFile,
    withBaselineHeader(
      await Bun.file(referenceFile).text(),
      await Bun.file(reference).text(),
      next,
    ),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

const drift = await productionDrift();
if (drift.length > 0)
  throw new Error(`Production differs from the new baseline:\n${drift.join('\n')}`);
console.log(`Baseline regenerated through ${number}; production matches it.`);

const sqlTime = (value: string) => Date.parse(`${value.replace(' ', 'T')}Z`);
const deadline = Date.now() + HEARTBEAT_WAIT_MS;
let heartbeat = await lastHeartbeat();
while ((heartbeat === null || sqlTime(heartbeat) < startedAt.getTime()) && Date.now() < deadline) {
  await Bun.sleep(15_000);
  heartbeat = await lastHeartbeat();
}
if (heartbeat === null || sqlTime(heartbeat) < startedAt.getTime()) {
  console.error(
    `No daemon heartbeat since ${startedAt.toISOString()} (last: ${heartbeat ?? 'never'}). Check the Worker's D1 writes.`,
  );
  process.exitCode = 1;
} else {
  console.log(`Daemon heartbeat at ${heartbeat} UTC, after the migration.`);
}
console.log(
  `\nCommit migrations/schema.sql and reference-data.sql: "chore(d1): regenerate the baseline through ${number}"`,
);
