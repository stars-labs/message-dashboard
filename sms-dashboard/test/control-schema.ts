import type { Database } from 'bun:sqlite';
import { createBalanceSchema } from './balance-schema.js';

/**
 * The tables the daemon control routes write, on top of the balance schema.
 * Their creating migrations reference tables production no longer has
 * (users, permissions), so these are the production definitions; the
 * filter_rule_id column is added the way migration 035 adds it.
 */
export async function createControlSchema(database: Database): Promise<void> {
  await createBalanceSchema(database);
  database.run(`
    CREATE TABLE daemon_health (
      daemon_id TEXT PRIMARY KEY,
      last_heartbeat TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'online',
      last_ip TEXT,
      version TEXT,
      modem_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      current_session_id TEXT,
      last_full_sync TIMESTAMP,
      sync_mode TEXT DEFAULT 'incremental'
    );
    CREATE TABLE keyword_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      tag TEXT NOT NULL,
      color TEXT DEFAULT '#3B82F6',
      priority INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      case_sensitive BOOLEAN DEFAULT FALSE,
      whole_word BOOLEAN DEFAULT FALSE,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE message_tags (
      message_id TEXT NOT NULL,
      keyword_tag_id INTEGER NOT NULL,
      matched_text TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, keyword_tag_id, position),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
    );
    CREATE TABLE filter_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('body_keyword', 'sender')),
      pattern TEXT NOT NULL,
      note TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(rule_type, pattern)
    );
    ALTER TABLE messages ADD COLUMN filter_rule_id INTEGER
      REFERENCES filter_rules(id) ON DELETE SET NULL;
  `);
}
