import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { iccidMappingsHandler, resolveServiceType, resolveSimRole } from './iccid-mappings.js';

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
  database.exec(`PRAGMA foreign_keys = ON;`);
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
  const migration2 = await Bun.file(new URL('../../migrations/059_add_sim_primary_secondary.sql', import.meta.url)).text();
  database.exec(migration2);
  const migration3 = await Bun.file(new URL('../../migrations/062_add_balance_threshold.sql', import.meta.url)).text();
  database.exec(migration3);
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

  test('accepts balance-managed SIMs without verification metadata', () => {
    expect(resolveServiceType({
      service_type: 'balance_managed',
      service_type_source: 'carrier_message',
    })).toEqual({
      serviceType: 'balance_managed',
      serviceTypeSource: null,
      serviceTypeProvided: true,
    });
  });

  test('rejects the replaced n/a service type', () => {
    expect(resolveServiceType({ service_type: 'n/a' })).toEqual({
      error: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
    });
  });

  test('rejects unsupported inferred categories', () => {
    expect(resolveServiceType({ service_type: 'hybrid' })).toEqual({
      error: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
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

describe('SIM primary/secondary role validation', () => {
  test('defaults to standalone with no primary_iccid', () => {
    const database = new Database(':memory:');
    database.exec(`CREATE TABLE sims (iccid TEXT PRIMARY KEY, sim_role TEXT, primary_iccid TEXT)`);
    const env = { DB: createD1Adapter(database) };
    expect(resolveSimRole({}, null, env)).resolves.toEqual({
      role: 'standalone',
      primaryIccid: null,
      roleProvided: false,
    });
    database.close();
  });

  test('rejects an invalid role', async () => {
    const database = new Database(':memory:');
    database.exec(`CREATE TABLE sims (iccid TEXT PRIMARY KEY, sim_role TEXT, primary_iccid TEXT)`);
    const env = { DB: createD1Adapter(database) };
    const result = await resolveSimRole({ sim_role: 'backup' }, null, env);
    expect(result).toEqual({ error: 'sim_role must be standalone, primary, or secondary' });
    database.close();
  });

  test('secondary without primary_iccid is rejected', async () => {
    const database = new Database(':memory:');
    database.exec(`CREATE TABLE sims (iccid TEXT PRIMARY KEY, sim_role TEXT, primary_iccid TEXT)`);
    const env = { DB: createD1Adapter(database) };
    const result = await resolveSimRole({ sim_role: 'secondary' }, null, env);
    expect(result).toEqual({ error: 'primary_iccid is required for a secondary SIM' });
    database.close();
  });

  test('secondary pointing at a non-existent SIM is rejected', async () => {
    const database = new Database(':memory:');
    database.exec(`CREATE TABLE sims (iccid TEXT PRIMARY KEY, sim_role TEXT, primary_iccid TEXT)`);
    const env = { DB: createD1Adapter(database) };
    const result = await resolveSimRole({
      sim_role: 'secondary',
      primary_iccid: 'missing-iccid',
    }, null, env);
    expect(result).toEqual({ error: 'primary_iccid does not match any SIM' });
    database.close();
  });

  test('secondary pointing at a standalone SIM is rejected', async () => {
    const database = new Database(':memory:');
    database.exec(`CREATE TABLE sims (iccid TEXT PRIMARY KEY, sim_role TEXT, primary_iccid TEXT)`);
    database.exec(`INSERT INTO sims (iccid, sim_role, primary_iccid) VALUES ('solo', 'standalone', NULL)`);
    const env = { DB: createD1Adapter(database) };
    const result = await resolveSimRole({
      sim_role: 'secondary',
      primary_iccid: 'solo',
    }, null, env);
    expect(result.error).toBe('primary_iccid points to a standalone SIM, not a primary');
    database.close();
  });

  test('secondary pointing at a real primary succeeds', async () => {
    const database = new Database(':memory:');
    database.exec(`CREATE TABLE sims (iccid TEXT PRIMARY KEY, sim_role TEXT, primary_iccid TEXT)`);
    database.exec(`INSERT INTO sims (iccid, sim_role, primary_iccid) VALUES ('main', 'primary', NULL)`);
    const env = { DB: createD1Adapter(database) };
    const result = await resolveSimRole({
      sim_role: 'secondary',
      primary_iccid: 'main',
    }, null, env);
    expect(result).toEqual({
      role: 'secondary',
      primaryIccid: 'main',
      roleProvided: true,
    });
    database.close();
  });

  test('SQL trigger refuses secondary with NULL primary_iccid on insert', async () => {
    const database = await createMigratedDatabase();
    expect(() => database.exec(
      `INSERT INTO sims (iccid, sim_index, phone_number, sim_role) VALUES ('x', 1, 'n', 'secondary')`
    )).toThrow('secondary SIM requires primary_iccid');
    database.close();
  });

  test('SQL trigger refuses primary with a primary_iccid set', async () => {
    const database = await createMigratedDatabase();
    expect(() => database.exec(
      `INSERT INTO sims (iccid, sim_index, phone_number, sim_role, primary_iccid) VALUES ('p', 1, 'n', 'primary', 'whatever')`
    )).toThrow('secondary SIM requires primary_iccid');
    database.close();
  });

  test('ON DELETE RESTRICT blocks deleting a primary with secondaries attached', async () => {
    const database = await createMigratedDatabase();
    database.exec(`INSERT INTO sims (iccid, sim_index, phone_number, sim_role, primary_iccid) VALUES ('main', 1, 'n', 'primary', NULL)`);
    database.exec(`INSERT INTO sims (iccid, sim_index, phone_number, sim_role, primary_iccid) VALUES ('sec', 2, 'n2', 'secondary', 'main')`);
    expect(() => database.exec(`DELETE FROM sims WHERE iccid = 'main'`))
      .toThrow('FOREIGN KEY constraint failed');
    database.close();
  });

  test('full create+update lifecycle through the handler', async () => {
    const database = await createMigratedDatabase();
    const env = { DB: createD1Adapter(database) };
    const user = { email: 'op@example.com' };

    // Create a primary
    const primaryResp = await iccidMappingsHandler.create({
      env, user,
      json: async () => ({
        iccid: 'primary-1', sim_index: 1, phone_number: '+861',
        sim_role: 'primary',
      }),
    });
    expect(primaryResp.status).toBe(201);

    // Create a secondary pointing at it
    const secResp = await iccidMappingsHandler.create({
      env, user,
      json: async () => ({
        iccid: 'secondary-1', sim_index: 2, phone_number: '+862',
        sim_role: 'secondary', primary_iccid: 'primary-1',
      }),
    });
    expect(secResp.status).toBe(201);

    const sec = database.query(`SELECT sim_role, primary_iccid FROM sims WHERE iccid = 'secondary-1'`).get();
    expect(sec).toEqual({ sim_role: 'secondary', primary_iccid: 'primary-1' });

    // Flip it back to standalone via update — primary_iccid must clear
    const updateResp = await iccidMappingsHandler.update({
      env, user, params: { id: 'secondary-1' },
      json: async () => ({
        phone_number: '+862', sim_index: 2, sim_role: 'standalone',
      }),
    });
    expect(updateResp.status).toBe(200);
    const cleared = database.query(`SELECT sim_role, primary_iccid FROM sims WHERE iccid = 'secondary-1'`).get();
    expect(cleared).toEqual({ sim_role: 'standalone', primary_iccid: null });

    // Now deleting the primary should succeed (no secondaries attached)
    const delResp = await iccidMappingsHandler.delete({
      env, params: { id: 'primary-1' },
    });
    expect(delResp.status).toBe(200);
    database.close();
  });

  test('delete returns 409 when secondaries are still attached', async () => {
    const database = await createMigratedDatabase();
    const env = { DB: createD1Adapter(database) };
    const user = { email: 'op@example.com' };

    await iccidMappingsHandler.create({
      env, user,
      json: async () => ({ iccid: 'p', sim_index: 1, phone_number: 'n', sim_role: 'primary' }),
    });
    await iccidMappingsHandler.create({
      env, user,
      json: async () => ({ iccid: 's', sim_index: 2, phone_number: 'n2', sim_role: 'secondary', primary_iccid: 'p' }),
    });

    const delResp = await iccidMappingsHandler.delete({ env, params: { id: 'p' } });
    expect(delResp.status).toBe(409);
    const body = await delResp.json();
    expect(body.error).toMatch(/primary SIM with secondary/);
    database.close();
  });
});
