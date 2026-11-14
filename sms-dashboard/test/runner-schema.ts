import type { Database } from 'bun:sqlite';

const RUNNER_MIGRATIONS = [
  '054_add_unicom_web_balance_skill',
  '055_add_balance_runner_control_plane',
  '065_add_m1_prepaid_browser_balance',
];

/**
 * The balance runner tables as the migrations that created and rebuilt them
 * leave them. The other tables those migrations reference are reduced to the
 * columns they touch.
 */
export async function createRunnerSchema(database: Database): Promise<void> {
  database.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE messages (id TEXT PRIMARY KEY);
    CREATE TABLE sim_balance_checks (id TEXT PRIMARY KEY);
    CREATE TABLE sim_balance_profiles (
      id TEXT PRIMARY KEY, country_code TEXT, carrier TEXT, method TEXT,
      command TEXT, destination TEXT, expected_senders TEXT, parser_version TEXT,
      response_window_minutes INTEGER, discovery_enabled INTEGER, enabled INTEGER,
      conversation_steps TEXT, skill_config TEXT
    );
  `);
  for (const name of RUNNER_MIGRATIONS) {
    database.run(await Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text());
  }
}
