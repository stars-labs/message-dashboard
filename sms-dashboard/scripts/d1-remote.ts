// The production D1 calls the migration tooling makes, through the repository's wrangler.
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { parseJson } from '../shared/parse-json.ts';
import { BASELINE_FILES } from './migration-rules.ts';
import { parseBookmark, type RowCounts, type TableCounts } from './migration-apply-rules.ts';
import { REFERENCE_TABLES, schemaDrift } from './schema-drift.ts';

export const DATABASE = 'sms-dashboard';
export const root = join(import.meta.dirname, '..');
export const migrationsDir = join(root, 'migrations');
const WRANGLER = ['node', join(root, 'node_modules/wrangler/bin/wrangler.js')];

export async function wrangler(args: string[]): Promise<string> {
  const proc = Bun.spawn([...WRANGLER, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(`wrangler ${args.slice(0, 2).join(' ')} failed:\n${stdout}${stderr}`);
  return stdout;
}

export async function exportProduction(output: string, args: string[] = []): Promise<void> {
  await wrangler(['d1', 'export', DATABASE, '--remote', ...args, '--output', output]);
}

const Executed = v.array(
  v.object({
    results: v.optional(v.array(v.unknown()), []),
    meta: v.optional(
      v.object({ rows_read: v.optional(v.number(), 0), rows_written: v.optional(v.number(), 0) }),
      {},
    ),
  }),
);

function parseExecuted(stdout: string) {
  const parsed = parseJson(stdout, Executed);
  if (!parsed.ok) throw new Error(`Unexpected d1 execute output: ${parsed.error}\n${stdout}`);
  return parsed.value;
}

export async function queryProduction(sql: string): Promise<unknown[]> {
  const [first] = parseExecuted(
    await wrangler(['d1', 'execute', DATABASE, '--remote', '--json', '--command', sql]),
  );
  return first?.results ?? [];
}

export async function applyToProduction(file: string): Promise<RowCounts> {
  const executed = parseExecuted(
    await wrangler(['d1', 'execute', DATABASE, '--remote', '--json', '--yes', '--file', file]),
  );
  return executed.reduce(
    (sum, { meta }) => ({
      rowsRead: sum.rowsRead + meta.rows_read,
      rowsWritten: sum.rowsWritten + meta.rows_written,
    }),
    { rowsRead: 0, rowsWritten: 0 },
  );
}

export async function timeTravelBookmark(): Promise<string> {
  return parseBookmark(await wrangler(['d1', 'time-travel', 'info', DATABASE]));
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function countProduction(tables: readonly string[]): Promise<TableCounts> {
  if (tables.length === 0) return {};
  const existing = v
    .parse(
      v.array(v.object({ name: v.string() })),
      await queryProduction(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map((t) => `'${t}'`).join(', ')})`,
      ),
    )
    .map(({ name }) => name);
  if (existing.length === 0) return {};
  const [row] = await queryProduction(
    `SELECT ${existing.map((t) => `(SELECT COUNT(*) FROM ${quoted(t)}) AS ${quoted(t)}`).join(', ')}`,
  );
  return v.parse(v.record(v.string(), v.number()), row);
}

export async function lastHeartbeat(): Promise<string | null> {
  const [row] = v.parse(
    v.array(v.object({ last_heartbeat: v.nullable(v.string()) })),
    await queryProduction(
      "SELECT last_heartbeat FROM daemon_health WHERE daemon_id = 'orange-pi-main'",
    ),
  );
  return row?.last_heartbeat ?? null;
}

async function build(files: string[]): Promise<Database> {
  const db = new Database(':memory:');
  for (const file of files) db.run(await Bun.file(file).text());
  return db;
}

// Read-only: two `d1 export` calls, which briefly hold other D1 requests.
export async function productionDrift(): Promise<string[]> {
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
    return schemaDrift(
      await build(BASELINE_FILES.map((name) => join(migrationsDir, name))),
      await build([schema, ...data]),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
