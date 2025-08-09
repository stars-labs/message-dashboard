/**
 * Database setup utility - ensures all required tables exist
 * Keeps infrastructure concerns separate from business logic
 */

export async function ensureTablesExist(db) {
  // Create modems table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS modems (
      equipment_id TEXT PRIMARY KEY,
      manufacturer TEXT,
      model TEXT,
      firmware_revision TEXT,
      hardware_revision TEXT,
      device_path TEXT,
      status TEXT DEFAULT 'disconnected',
      modem_index INTEGER,
      usb_port INTEGER,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create sims table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sims (
      iccid TEXT PRIMARY KEY,
      phone_number TEXT,
      carrier TEXT,
      operator_name TEXT,
      operator_id TEXT,
      country_code TEXT,
      status TEXT DEFAULT 'inactive',
      current_modem_id TEXT,
      activation_date TIMESTAMP,
      last_activity TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (current_modem_id) REFERENCES modems(equipment_id)
    )
  `).run();

  // Create modem_state table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS modem_state (
      modem_id TEXT PRIMARY KEY,
      connection_status TEXT,
      signal_percent INTEGER,
      rssi INTEGER,
      rsrq INTEGER,
      rsrp INTEGER,
      snr INTEGER,
      network_type TEXT,
      access_tech TEXT,
      band_info TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (modem_id) REFERENCES modems(equipment_id)
    )
  `).run();

  // Create daemon_health table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS daemon_health (
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
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create indexes for better performance
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_modems_status ON modems(status)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_modems_modem_index ON modems(modem_index)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_sims_status ON sims(status)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_sims_current_modem ON sims(current_modem_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_modem_state_status ON modem_state(connection_status)`).run();
}

/**
 * Ensure keyword tables exist for message tagging
 */
export async function ensureKeywordTablesExist(db) {
  // Create keyword_tags table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS keyword_tags (
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
    )
  `).run();

  // Create message_tags table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS message_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      keyword_tag_id INTEGER NOT NULL,
      matched_text TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE,
      UNIQUE(message_id, keyword_tag_id, position)
    )
  `).run();

  // Create indexes
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_keyword_tags_keyword ON keyword_tags(keyword)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_keyword_tags_active ON keyword_tags(is_active)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_message_tags_message ON message_tags(message_id)`).run();
}