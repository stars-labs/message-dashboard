// Runs SQL on a copy of production in an isolated local D1 and measures it the way D1
// bills it: Miniflare's D1 counts rows read and written with the same Durable Object
// SQLite counters, so index entries and DDL are included (100 rows into a table with two
// indexes write 300; CREATE TRIGGER writes 1, as 085 and 086 did in production).
import { Database } from 'bun:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { getPlatformProxy } from 'wrangler';
import type { CountsAround, RowCounts, TableCounts } from './migration-apply-rules.ts';
import { DATABASE, exportProduction } from './d1-remote.ts';

export interface Rehearsal extends RowCounts {
  counts: CountsAround;
}

const CONFIG = `name = "rehearsal"
compatibility_date = "2026-11-01"

[[d1_databases]]
binding = "DB"
database_name = "${DATABASE}"
database_id = "rehearsal"
`;

async function findDatabaseFile(dir: string): Promise<string> {
  for (const entry of await readdir(dir, { recursive: true })) {
    if (entry.endsWith('.sqlite') && !entry.endsWith('metadata.sqlite')) return join(dir, entry);
  }
  throw new Error(`No local D1 database under ${dir}`);
}

function countRows(file: string, tables: readonly string[]): TableCounts {
  const db = new Database(file, { readonly: true });
  try {
    const existing = new Set(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .values()
        .map(([name]) => String(name)),
    );
    const counts: TableCounts = {};
    for (const table of tables.filter((name) => existing.has(name))) {
      const [count] =
        db.query(`SELECT COUNT(*) FROM "${table.replaceAll('"', '""')}"`).values()[0] ?? [];
      counts[table] = Number(count);
    }
    return counts;
  } finally {
    db.close();
  }
}

interface LocalStatement {
  run(): Promise<unknown>;
}

interface LocalD1 {
  prepare(sql: string): LocalStatement;
  batch(statements: LocalStatement[]): Promise<unknown>;
}

const BatchResults = v.array(
  v.object({ meta: v.object({ rows_read: v.number(), rows_written: v.number() }) }),
);

async function withLocalD1<T>(dir: string, use: (db: LocalD1) => Promise<T>): Promise<T> {
  const proxy = await getPlatformProxy<{ DB: LocalD1 }>({
    configPath: join(dir, 'wrangler.toml'),
    persist: { path: join(dir, 'state') },
  });
  try {
    return await use(proxy.env.DB);
  } finally {
    await proxy.dispose();
  }
}

// The production export holds phone numbers and message text: it lives in a private
// temporary directory and is deleted with the rehearsal.
export async function rehearse(
  statements: readonly string[],
  tables: readonly string[],
): Promise<Rehearsal> {
  const dir = await mkdtemp(join(tmpdir(), 'sms-dashboard-rehearsal-'));
  try {
    await Bun.write(join(dir, 'wrangler.toml'), CONFIG);
    const dump = join(dir, 'production.sql');
    await exportProduction(dump);
    await withLocalD1(dir, (db) => db.prepare('SELECT 1').run());

    const file = await findDatabaseFile(join(dir, 'state'));
    const copy = new Database(file);
    try {
      copy.run('PRAGMA foreign_keys = OFF;');
      copy.run((await Bun.file(dump).text()).replaceAll('\0', "'||char(0)||'"));
    } finally {
      copy.close();
    }
    await rm(dump);

    const before = countRows(file, tables);
    const results = v.parse(
      BatchResults,
      await withLocalD1(dir, (db) => db.batch(statements.map((sql) => db.prepare(sql)))),
    );
    const after = countRows(file, tables);
    return {
      rowsRead: results.reduce((sum, { meta }) => sum + meta.rows_read, 0),
      rowsWritten: results.reduce((sum, { meta }) => sum + meta.rows_written, 0),
      counts: { before, after },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
