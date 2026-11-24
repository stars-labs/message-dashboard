// bun run check:schema-drift: compares production D1 with the baseline
// (migrations/schema.sql + reference-data.sql). Read-only: two `d1 export` calls,
// which briefly hold other D1 requests. Run after applying a migration to production.
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_FILES } from './migration-rules.ts';
import { REFERENCE_TABLES, schemaDrift } from './schema-drift.ts';

const root = join(import.meta.dirname, '..');
const WRANGLER = ['node', join(root, 'node_modules/wrangler/bin/wrangler.js')];

async function exportProduction(output: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(
    [...WRANGLER, 'd1', 'export', 'sms-dashboard', '--remote', ...args, '--output', output],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`d1 export failed:\n${await new Response(proc.stderr).text()}`);
  }
}

async function build(files: string[]): Promise<Database> {
  const db = new Database(':memory:');
  for (const file of files) db.run(await Bun.file(file).text());
  return db;
}

const dir = await mkdtemp(join(tmpdir(), 'sms-dashboard-drift-'));
try {
  const schema = join(dir, 'schema.sql');
  await exportProduction(schema, ['--no-data']);
  const data = await Promise.all(
    REFERENCE_TABLES.map(async ({ table }) => {
      const file = join(dir, `${table}.sql`);
      await exportProduction(file, ['--table', table, '--no-schema']);
      return file;
    }),
  );

  const drift = schemaDrift(
    await build(BASELINE_FILES.map((name) => join(root, 'migrations', name))),
    await build([schema, ...data]),
  );
  if (drift.length > 0) {
    console.error(
      `Production differs from the baseline; regenerate it (see migrations/schema.sql):\n${drift.join('\n')}`,
    );
    process.exitCode = 1;
  } else {
    console.log('Production matches migrations/schema.sql and reference-data.sql.');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
