import type { Database } from 'bun:sqlite';
import { createSimsSchema } from './sims-schema.js';

const BALANCE_MIGRATIONS = [
  '039_add_sim_balance_queries',
  '040_add_balance_conversation_steps',
  '042_add_balance_runtime_skills',
  '051_add_sms_processing_session',
  '054_add_unicom_web_balance_skill',
  '055_add_balance_runner_control_plane',
  '057_scope_balance_jobs_to_auth0_subject',
  '065_add_m1_prepaid_browser_balance',
  '075_optimize_balance_otp_cursor',
  '076_optimize_balance_runtime',
];

/**
 * The balance tables as the migrations leave them, on top of the real sims and
 * device_view. `messages` starts with the production columns these migrations
 * do not add, less filter_rule_id, whose filter_rules table is out of scope.
 */
export async function createBalanceSchema(database: Database): Promise<void> {
  await createSimsSchema(database);
  database.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      phone_iccid TEXT,
      phone_number TEXT,
      content TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      type TEXT CHECK(type IN ('sent', 'received')),
      status TEXT,
      recipient TEXT,
      verification_code TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT,
      sms_id TEXT,
      filter_status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  for (const name of BALANCE_MIGRATIONS) {
    database.run(await Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text());
  }
}
