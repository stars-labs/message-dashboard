import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('balance-managed service type migration', () => {
  test('replaces n/a data and rejects the old enum value', async () => {
    const database = new Database(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
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
        updated_by TEXT,
        service_type TEXT NOT NULL DEFAULT 'unknown'
          CHECK(service_type IN ('unknown', 'prepaid', 'postpaid', 'n/a')),
        service_type_source TEXT,
        service_type_verified_at TIMESTAMP,
        sim_role TEXT NOT NULL DEFAULT 'standalone',
        primary_iccid TEXT REFERENCES sims(iccid) ON DELETE RESTRICT,
        balance_threshold REAL
      );
      CREATE INDEX idx_sims_sim_index ON sims(sim_index);
      CREATE UNIQUE INDEX idx_sims_imei_unique ON sims(imei) WHERE imei IS NOT NULL;
      CREATE VIEW device_view AS SELECT iccid, service_type FROM sims;
      INSERT INTO sims (
        iccid, sim_index, phone_number, country_code, service_type
      ) VALUES ('cn-sim', 1, '+8613500000000', 'CN', 'n/a');
      UPDATE sims SET sim_role = 'primary' WHERE iccid = 'cn-sim';
      INSERT INTO sims (
        iccid, sim_index, phone_number, country_code, service_type,
        sim_role, primary_iccid
      ) VALUES (
        'cn-secondary', 2, '+8613500000001', 'CN', 'n/a',
        'secondary', 'cn-sim'
      );
      INSERT INTO sims (
        iccid, sim_index, phone_number, country_code, service_type,
        service_type_source, service_type_verified_at
      ) VALUES (
        'sg-sim', 3, '+6590000000', 'SG', 'prepaid',
        'carrier_account', CURRENT_TIMESTAMP
      );
    `);

    const replaceEnum = await Bun.file(
      new URL('./063_replace_na_service_type.sql', import.meta.url),
    ).text();
    const recreateView = await Bun.file(
      new URL('./064_recreate_device_view.sql', import.meta.url),
    ).text();
    database.exec(replaceEnum);
    database.exec(recreateView);

    expect(database.query(`
      SELECT iccid, service_type FROM sims ORDER BY sim_index
    `).all()).toEqual([
      { iccid: 'cn-sim', service_type: 'balance_managed' },
      { iccid: 'cn-secondary', service_type: 'balance_managed' },
      { iccid: 'sg-sim', service_type: 'prepaid' },
    ]);
    expect(database.query(`
      SELECT service_type FROM device_view WHERE iccid = 'cn-sim'
    `).get()).toEqual({ service_type: 'balance_managed' });
    expect(() => database.query(`
      INSERT INTO sims (iccid, sim_index, phone_number, service_type)
      VALUES ('old-value', 4, '+86000', 'n/a')
    `).run()).toThrow();
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => database.query(`
      DELETE FROM sims WHERE iccid = 'cn-sim'
    `).run()).toThrow();
    database.close();
  });
});
