// Runs SQL on a copy of production in an isolated local D1 (local-d1.ts), measured the
// way D1 bills it.
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import type { CountsAround, RowCounts, TableCounts } from './migration-apply-rules.ts';
import { exportProduction } from './d1-remote.ts';
import { createLocalD1, withLocalD1 } from './local-d1.ts';

export interface Rehearsal extends RowCounts {
  counts: CountsAround;
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

const BatchResults = v.array(
  v.object({ meta: v.object({ rows_read: v.number(), rows_written: v.number() }) }),
);

// The production export holds phone numbers and message text: it lives in a private
// temporary directory and is deleted with the rehearsal.
export async function rehearse(
  statements: readonly string[],
  tables: readonly string[],
): Promise<Rehearsal> {
  const dir = await mkdtemp(join(tmpdir(), 'sms-dashboard-rehearsal-'));
  try {
    const file = await createLocalD1(dir);
    const dump = join(dir, 'production.sql');
    await exportProduction(dump);
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
