import type { Database } from 'bun:sqlite';

const SIMS_MIGRATIONS = [
  '058_add_sim_service_type',
  '059_add_sim_primary_secondary',
  '060_add_na_service_type',
  '061_recreate_device_view',
  '062_add_balance_threshold',
  '063_replace_na_service_type',
  '064_recreate_device_view',
];

/**
 * The sims and modems tables as they were before migration 058, then the
 * migrations that rebuilt sims and device_view, so tests read the real view.
 */
export async function createSimsSchema(database: Database): Promise<void> {
  database.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (
      iccid TEXT PRIMARY KEY,
      sim_index INTEGER NOT NULL,
      phone_number TEXT NOT NULL,
      country_code TEXT,
      carrier TEXT,
      imei TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    );
    CREATE TABLE modems (
      equipment_id TEXT PRIMARY KEY,
      manufacturer TEXT,
      model TEXT,
      usb_port TEXT,
      usb_path TEXT,
      last_usb_path TEXT,
      status TEXT,
      detected_operator TEXT,
      signal_percent INTEGER,
      detected_iccid TEXT,
      detected_phone_number TEXT
    );
  `);
  for (const name of SIMS_MIGRATIONS) {
    database.run(await Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text());
  }
}
