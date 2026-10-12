#!/usr/bin/env bun

import { Database } from 'bun:sqlite';

const db = new Database('./data/sqlite.db');

const missingTables = `
CREATE TABLE IF NOT EXISTS daemon_health (
  daemon_id TEXT PRIMARY KEY,
  hostname TEXT,
  ip_address TEXT,
  version TEXT,
  status TEXT DEFAULT 'unknown',
  connected_modems INTEGER DEFAULT 0,
  active_sims INTEGER DEFAULT 0,
  last_heartbeat TEXT DEFAULT CURRENT_TIMESTAMP,
  uptime_seconds INTEGER,
  cpu_usage REAL,
  memory_usage REAL,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS modem_state (
  modem_id TEXT PRIMARY KEY REFERENCES modems(equipment_id),
  connection_status TEXT,
  signal_percent INTEGER,
  rssi INTEGER,
  rsrq INTEGER,
  rsrp INTEGER,
  snr INTEGER,
  access_tech TEXT,
  modem_index INTEGER,
  usb_port INTEGER,
  sim_index INTEGER,
  last_heartbeat TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sims (
  iccid TEXT PRIMARY KEY,
  phone_number TEXT,
  carrier TEXT,
  operator_name TEXT,
  operator_id TEXT,
  country_code TEXT,
  status TEXT DEFAULT 'inactive',
  current_modem_id TEXT REFERENCES modems(equipment_id),
  activation_date TEXT,
  last_activity TEXT,
  sim_index INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS keyword_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  tag TEXT NOT NULL,
  color TEXT DEFAULT '#3B82F6',
  priority INTEGER DEFAULT 0,
  case_sensitive INTEGER DEFAULT 0,
  whole_word INTEGER DEFAULT 0,
  usage_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_tags (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  keyword_tag_id INTEGER NOT NULL REFERENCES keyword_tags(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

db.exec(missingTables);

const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(`✅ Database now has ${tables.length} tables:`, tables.map(t => t.name).join(', '));

db.close();