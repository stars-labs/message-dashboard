import type { Database } from 'bun:sqlite';
import { createSimsSchema } from './sims-schema.js';

const WEB_BALANCE_MIGRATIONS = [
  '039_add_sim_balance_queries',
  '040_add_balance_conversation_steps',
  '042_add_balance_runtime_skills',
  '054_add_unicom_web_balance_skill',
  '055_add_balance_runner_control_plane',
  '057_scope_balance_jobs_to_auth0_subject',
  '065_add_m1_prepaid_browser_balance',
  '075_optimize_balance_otp_cursor',
  '076_optimize_balance_runtime',
];

/**
 * The browser balance tables as the migrations leave them, on top of the real
 * sims and device_view. Only `messages` is reduced to the columns these
 * migrations and the OTP query touch.
 */
export async function createWebBalanceSchema(database: Database): Promise<void> {
  await createSimsSchema(database);
  database.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT,
      verification_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (const name of WEB_BALANCE_MIGRATIONS) {
    database.run(await Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text());
  }
}
