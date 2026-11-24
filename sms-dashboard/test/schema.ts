import type { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import { baselineThrough, databaseFiles } from '../scripts/migration-rules.ts';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/**
 * Production's database before any user data: the exported schema and reference
 * data, then each migration written since. Foreign keys are enforced, as D1 enforces them.
 */
export async function createSchema(database: Database): Promise<void> {
  const through = baselineThrough(await Bun.file(new URL('schema.sql', MIGRATIONS)).text());
  database.run('PRAGMA foreign_keys = ON;');
  for (const name of databaseFiles(readdirSync(MIGRATIONS), through)) {
    database.run(await Bun.file(new URL(name, MIGRATIONS)).text());
  }
}
