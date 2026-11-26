// An isolated local D1, through wrangler's getPlatformProxy. Miniflare's D1 counts rows
// read and written with the Durable Object SQLite counters production D1 bills by, index
// entries and DDL included: 100 rows into a table with two indexes write 300, and
// CREATE TRIGGER writes 1, as 085 and 086 did in production.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';

const CONFIG = `name = "local-d1"
compatibility_date = "2026-11-01"

[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"
database_id = "local"
`;

export interface LocalStatement {
  bind(...values: unknown[]): LocalStatement;
  all(): Promise<unknown>;
  run(): Promise<unknown>;
}

export interface LocalD1 {
  prepare(sql: string): LocalStatement;
  batch(statements: LocalStatement[]): Promise<unknown>;
}

export interface RunningD1 {
  db: LocalD1;
  dispose(): Promise<void>;
}

export async function startLocalD1(dir: string): Promise<RunningD1> {
  const proxy = await getPlatformProxy<{ DB: LocalD1 }>({
    configPath: join(dir, 'wrangler.toml'),
    persist: { path: join(dir, 'state') },
  });
  return { db: proxy.env.DB, dispose: () => proxy.dispose() };
}

export async function withLocalD1<T>(dir: string, use: (db: LocalD1) => Promise<T>): Promise<T> {
  const local = await startLocalD1(dir);
  try {
    return await use(local.db);
  } finally {
    await local.dispose();
  }
}

/**
 * Creates an empty local D1 under `dir` and returns its SQLite file, for bun:sqlite to fill
 * while no Miniflare holds it.
 */
export async function createLocalD1(dir: string): Promise<string> {
  await Bun.write(join(dir, 'wrangler.toml'), CONFIG);
  await withLocalD1(dir, (db) => db.prepare('SELECT 1').run());
  const state = join(dir, 'state');
  for (const entry of await readdir(state, { recursive: true })) {
    if (entry.endsWith('.sqlite') && !entry.endsWith('metadata.sqlite')) return join(state, entry);
  }
  throw new Error(`No local D1 database under ${state}`);
}
