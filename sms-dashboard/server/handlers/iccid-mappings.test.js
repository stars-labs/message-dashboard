import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { iccidMappingsHandler, resolveServiceType } from './iccid-mappings.js';

function createD1Adapter(database) {
  return {
    prepare(sql) {
      let params = [];
      const prepared = {
        bind(...values) {
          params = values;
          return prepared;
        },
        first() {
          return database.query(sql).get(...params);
        },
        all() {
          return { results: database.query(sql).all(...params) };
        },
        run() {
          return database.query(sql).run(...params);
        },
      };
      return prepared;
    },
  };
}

async function createMigratedDatabase() {
  const database = new Database(':memory:');
  database.exec(`
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
    CREATE VIEW device_view AS SELECT iccid FROM sims;
  `);
  const migration = await Bun.file(new URL('../../migrations/058_add_sim_service_type.sql', import.meta.url)).text();
  database.exec(migration);
  return database;
}

describe('SIM service type validation', () => {
  test('defaults new SIMs to unknown without verification metadata', () => {
    expect(resolveServiceType({})).toEqual({
      serviceType: 'unknown',
      serviceTypeSource: null,
      serviceTypeProvided: false,
    });
  });

  test('requires a controlled source for a confirmed type', () => {
    expect(resolveServiceType({ service_type: 'prepaid' })).toEqual({
      error: 'A valid service_type_source is required for prepaid or postpaid SIMs',
    });
    expect(resolveServiceType({
      service_type: 'postpaid',
      service_type_source: 'contract_or_bill',
    })).toEqual({
      serviceType: 'postpaid',
      serviceTypeSource: 'contract_or_bill',
      serviceTypeProvided: true,
    });
  });

  test('preserves an existing confirmation when an update omits the fields', () => {
    expect(resolveServiceType({}, {
      service_type: 'prepaid',
      service_type_source: 'carrier_account',
    })).toEqual({
      serviceType: 'prepaid',
      serviceTypeSource: 'carrier_account',
      serviceTypeProvided: false,
    });
  });

  test('clears source metadata when explicitly reset to unknown', () => {
    expect(resolveServiceType({
      service_type: 'unknown',
      service_type_source: 'carrier_message',
    })).toEqual({
      serviceType: 'unknown',
      serviceTypeSource: null,
      serviceTypeProvided: true,
    });
  });

  test('rejects unsupported inferred categories', () => {
    expect(resolveServiceType({ service_type: 'hybrid' })).toEqual({
      error: 'service_type must be unknown, prepaid, or postpaid',
    });
  });

  test('persists and clears manual confirmation through the real migrated schema', async () => {
    const database = await createMigratedDatabase();
    const env = { DB: createD1Adapter(database) };
    const user = { email: 'operator@example.com' };

    const createResponse = await iccidMappingsHandler.create({
      env,
      user,
      json: async () => ({
        iccid: 'test-iccid',
        sim_index: 1,
        phone_number: '+6500000000',
        country_code: 'SG',
        carrier: 'Test Carrier',
        service_type: 'postpaid',
        service_type_source: 'contract_or_bill',
      }),
    });
    expect(createResponse.status).toBe(201);

    const confirmed = database.query(`
      SELECT service_type, service_type_source, service_type_verified_at, updated_by
      FROM sims WHERE iccid = 'test-iccid'
    `).get();
    expect(confirmed.service_type).toBe('postpaid');
    expect(confirmed.service_type_source).toBe('contract_or_bill');
    expect(confirmed.service_type_verified_at).toBeTruthy();
    expect(confirmed.updated_by).toBe(user.email);

    const updateResponse = await iccidMappingsHandler.update({
      env,
      user,
      params: { id: 'test-iccid' },
      json: async () => ({
        phone_number: '+6500000000',
        sim_index: 1,
        country_code: 'SG',
        carrier: 'Test Carrier',
        service_type: 'unknown',
        service_type_source: null,
      }),
    });
    expect(updateResponse.status).toBe(200);

    const reset = database.query(`
      SELECT service_type, service_type_source, service_type_verified_at
      FROM sims WHERE iccid = 'test-iccid'
    `).get();
    expect(reset).toEqual({
      service_type: 'unknown',
      service_type_source: null,
      service_type_verified_at: null,
    });
    expect(() => database.query(`
      UPDATE sims
      SET service_type = 'postpaid',
          service_type_source = NULL,
          service_type_verified_at = NULL
      WHERE iccid = 'test-iccid'
    `).run()).toThrow('invalid SIM service type verification metadata');
    database.close();
  });
});
