import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const daemon_health = sqliteTable('daemon_health', {
  daemon_id: text('daemon_id').primaryKey(),
  hostname: text('hostname'),
  ip_address: text('ip_address'),
  version: text('version'),
  status: text('status').default('unknown'),
  connected_modems: integer('connected_modems').default(0),
  active_sims: integer('active_sims').default(0),
  last_heartbeat: text('last_heartbeat').default(sql`CURRENT_TIMESTAMP`),
  uptime_seconds: integer('uptime_seconds'),
  cpu_usage: real('cpu_usage'),
  memory_usage: real('memory_usage'),
  error_count: integer('error_count').default(0),
  last_error: text('last_error'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});